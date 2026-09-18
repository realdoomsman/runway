// Demo colony: seeds DEMO_AGENTS agents with the mock provider + memory chain, fast-forwards the
// FastClock through DEMO_DAYS of real step-loop runs, then releases the clock to real time. SPEC §8.18.
export { runDemo, PENDING_SALES, TICK_HOURS } from './demo.js';
export { colonyCast, type ColonyMember } from './colony.js';
