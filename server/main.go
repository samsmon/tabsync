// tabsync server: a dumb, end-to-end-encrypted record store.
// The server never sees URLs or titles — only opaque ciphertext blobs.
package main

import (
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

type Record struct {
	ID      string `json:"id"`
	TS      int64  `json:"ts"`      // client HLC-ish timestamp; last writer wins
	Deleted bool   `json:"deleted"` // tombstone
	Blob    string `json:"blob"`    // base64(iv|ciphertext), empty when deleted
	Seq     int64  `json:"seq"`     // server-assigned, monotonic
}

type server struct {
	db    *sql.DB
	token string
}

func main() {
	token := os.Getenv("TABSYNC_TOKEN")
	if len(token) < 16 {
		log.Fatal("TABSYNC_TOKEN must be set (>=16 chars)")
	}
	dbPath := env("TABSYNC_DB", "tabsync.db")
	addr := env("TABSYNC_ADDR", ":8080")

	db, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(1) // single writer; keeps memory tiny
	if _, err := db.Exec(schema); err != nil {
		log.Fatal(err)
	}

	s := &server{db: db, token: token}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /v1/meta", s.auth(s.getMeta))
	mux.HandleFunc("PUT /v1/meta", s.auth(s.putMeta))
	mux.HandleFunc("GET /v1/pull", s.auth(s.pull))
	mux.HandleFunc("POST /v1/push", s.auth(s.push))

	log.Printf("tabsync listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, cors(mux)))
}

const schema = `
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  blob TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

// Meta holds the KDF salt and a passphrase verifier (both non-secret).
// It can only be set once so a second device can't clobber the key setup.
func (s *server) getMeta(w http.ResponseWriter, r *http.Request) {
	var v string
	err := s.db.QueryRow(`SELECT v FROM meta WHERE k='crypto'`).Scan(&v)
	if err == sql.ErrNoRows {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if err != nil {
		httpErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(v))
}

func (s *server) putMeta(w http.ResponseWriter, r *http.Request) {
	body, err := readLimited(w, r, 4<<10)
	if err != nil || !json.Valid(body) {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	res, err := s.db.Exec(`INSERT OR IGNORE INTO meta(k,v) VALUES('crypto',?)`, string(body))
	if err != nil {
		httpErr(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		http.Error(w, "already initialized", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (s *server) pull(w http.ResponseWriter, r *http.Request) {
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	rows, err := s.db.Query(`SELECT id,ts,deleted,blob,seq FROM records WHERE seq>? ORDER BY seq LIMIT ?`, since, limit)
	if err != nil {
		httpErr(w, err)
		return
	}
	defer rows.Close()
	out := struct {
		Records []Record `json:"records"`
		Cursor  int64    `json:"cursor"`
		More    bool     `json:"more"`
	}{Records: []Record{}, Cursor: since}
	for rows.Next() {
		var rec Record
		if err := rows.Scan(&rec.ID, &rec.TS, &rec.Deleted, &rec.Blob, &rec.Seq); err != nil {
			httpErr(w, err)
			return
		}
		out.Records = append(out.Records, rec)
		out.Cursor = rec.Seq
	}
	out.More = len(out.Records) == limit
	writeJSON(w, out)
}

func (s *server) push(w http.ResponseWriter, r *http.Request) {
	body, err := readLimited(w, r, 8<<20)
	if err != nil {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
		return
	}
	var in struct {
		Records []Record `json:"records"`
	}
	if err := json.Unmarshal(body, &in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	tx, err := s.db.Begin()
	if err != nil {
		httpErr(w, err)
		return
	}
	defer tx.Rollback()
	var seq int64
	if err := tx.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM records`).Scan(&seq); err != nil {
		httpErr(w, err)
		return
	}
	accepted := 0
	for _, rec := range in.Records {
		if rec.ID == "" || len(rec.ID) > 64 {
			continue
		}
		if rec.Deleted {
			rec.Blob = ""
		}
		seq++
		// Last-writer-wins: only overwrite when the incoming ts is newer.
		res, err := tx.Exec(`
INSERT INTO records(id,ts,deleted,blob,seq) VALUES(?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, deleted=excluded.deleted, blob=excluded.blob, seq=excluded.seq
WHERE excluded.ts > records.ts`, rec.ID, rec.TS, rec.Deleted, rec.Blob, seq)
		if err != nil {
			httpErr(w, err)
			return
		}
		if n, _ := res.RowsAffected(); n > 0 {
			accepted++
		} else {
			seq--
		}
	}
	if err := tx.Commit(); err != nil {
		httpErr(w, err)
		return
	}
	writeJSON(w, map[string]int{"accepted": accepted})
}

func (s *server) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		h(w, r)
	}
}

// Extensions call from chrome-extension:// origins; auth is by bearer token, not cookies.
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func readLimited(w http.ResponseWriter, r *http.Request, n int64) ([]byte, error) {
	return io.ReadAll(http.MaxBytesReader(w, r.Body, n))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func httpErr(w http.ResponseWriter, err error) {
	log.Print(err)
	http.Error(w, "internal error", http.StatusInternalServerError)
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
