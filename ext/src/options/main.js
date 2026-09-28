import { mount } from 'svelte';
import '../lib/theme.css';
import { applyTheme } from '../lib/theme.js';
import Options from './Options.svelte';

applyTheme();
mount(Options, { target: document.getElementById('app') });
