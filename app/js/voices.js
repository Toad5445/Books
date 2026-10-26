// Kokoro's English voices. Grades are Kokoro's own quality ratings (A is best).

export const VOICES = [
  { id: 'af_heart', name: 'Heart', group: 'American · Female', grade: 'A' },
  { id: 'af_bella', name: 'Bella', group: 'American · Female', grade: 'A-' },
  { id: 'af_nicole', name: 'Nicole', group: 'American · Female', grade: 'B-' },
  { id: 'af_aoede', name: 'Aoede', group: 'American · Female', grade: 'C+' },
  { id: 'af_kore', name: 'Kore', group: 'American · Female', grade: 'C+' },
  { id: 'af_sarah', name: 'Sarah', group: 'American · Female', grade: 'C+' },
  { id: 'af_nova', name: 'Nova', group: 'American · Female', grade: 'C' },
  { id: 'af_sky', name: 'Sky', group: 'American · Female', grade: 'C-' },
  { id: 'af_alloy', name: 'Alloy', group: 'American · Female', grade: 'C' },
  { id: 'af_jessica', name: 'Jessica', group: 'American · Female', grade: 'D' },
  { id: 'af_river', name: 'River', group: 'American · Female', grade: 'D' },
  { id: 'am_michael', name: 'Michael', group: 'American · Male', grade: 'C+' },
  { id: 'am_fenrir', name: 'Fenrir', group: 'American · Male', grade: 'C+' },
  { id: 'am_puck', name: 'Puck', group: 'American · Male', grade: 'C+' },
  { id: 'am_echo', name: 'Echo', group: 'American · Male', grade: 'D' },
  { id: 'am_eric', name: 'Eric', group: 'American · Male', grade: 'D' },
  { id: 'am_liam', name: 'Liam', group: 'American · Male', grade: 'D' },
  { id: 'am_onyx', name: 'Onyx', group: 'American · Male', grade: 'D' },
  { id: 'am_adam', name: 'Adam', group: 'American · Male', grade: 'F+' },
  { id: 'am_santa', name: 'Santa', group: 'American · Male', grade: 'D-' },
  { id: 'bf_emma', name: 'Emma', group: 'British · Female', grade: 'B-' },
  { id: 'bf_isabella', name: 'Isabella', group: 'British · Female', grade: 'C' },
  { id: 'bf_alice', name: 'Alice', group: 'British · Female', grade: 'D' },
  { id: 'bf_lily', name: 'Lily', group: 'British · Female', grade: 'D' },
  { id: 'bm_george', name: 'George', group: 'British · Male', grade: 'C' },
  { id: 'bm_fable', name: 'Fable', group: 'British · Male', grade: 'C' },
  { id: 'bm_lewis', name: 'Lewis', group: 'British · Male', grade: 'D+' },
  { id: 'bm_daniel', name: 'Daniel', group: 'British · Male', grade: 'D' },
];

export const voiceById = (id) => VOICES.find((v) => v.id === id) || VOICES[0];
export const voiceName = (id) => voiceById(id).name;
