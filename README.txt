NEON STRIKE — fixed submission build

Files: index.html, main.js, style.css
Open index.html in a modern browser with internet access (Three.js loads from CDN).

Fixes included:
1. Fixed bot AI ReferenceError caused by using eyePos/playerPos/canSeePlayer before declaration.
2. Added missing difficulty reactionMs and aimJitter values so bot accuracy/reaction logic no longer becomes NaN.
