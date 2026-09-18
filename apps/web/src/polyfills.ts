// Node globals expected by wallet-adapter / web3.js in the browser.
// Imported first from main.tsx so it runs before any dependency evaluates.
import { Buffer } from 'buffer';

const g = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!g.Buffer) g.Buffer = Buffer;
