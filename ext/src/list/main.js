import { mount } from 'svelte';
import '../lib/theme.css';
import { applyTheme } from '../lib/theme.js';
import App from './App.svelte';

applyTheme();
mount(App, { target: document.getElementById('app') });
