export const daemonStatusStyles = `
  :host { all: initial; color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  .si-daemon-card {
    display: grid; width: min(330px, calc(100vw - 32px)); grid-template-columns: auto 1fr auto;
    align-items: center; gap: 11px; border: 1px solid #2b3740; border-radius: 14px; padding: 11px 12px;
    background: rgba(15, 21, 27, .96); color: #f5f7f9;
    box-shadow: 0 18px 48px rgba(0, 0, 0, .34), inset 0 1px rgba(255, 255, 255, .025);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-align: left; backdrop-filter: blur(10px);
  }
  .si-daemon-mark {
    display: grid; width: 31px; height: 31px; place-items: center;
    border: 1px solid rgba(85, 226, 166, .3); border-radius: 9px;
    background: rgba(85, 226, 166, .08); color: #5be0a8;
  }
  .si-daemon-mark svg {
    width: 18px; fill: none; stroke: currentColor; stroke-width: 1.7;
    stroke-linecap: round; stroke-linejoin: round;
  }
  .si-daemon-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .si-daemon-copy strong { color: #edf2f5; font-size: 12px; font-weight: 720; line-height: 1.3; }
  .si-daemon-copy small { color: #83909a; font-size: 10px; line-height: 1.4; }
  .si-daemon-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #5be0a8;
    box-shadow: 0 0 0 4px rgba(91, 224, 168, .1);
  }
  [data-state="checking"] .si-daemon-mark,
  [data-state="scanning"] .si-daemon-mark { border-color: rgba(104, 180, 255, .3); background: rgba(104, 180, 255, .08); color: #73baff; }
  [data-state="checking"] .si-daemon-dot,
  [data-state="scanning"] .si-daemon-dot { background: #73baff; box-shadow: 0 0 0 4px rgba(115, 186, 255, .1); }
  [data-state="scanning"] .si-daemon-dot { animation: si-pulse 1.1s ease-in-out infinite; }
  [data-state="offline"] { border-color: rgba(255, 105, 118, .3); }
  [data-state="offline"] .si-daemon-mark { border-color: rgba(255, 105, 118, .3); background: rgba(255, 91, 106, .08); color: #ff7581; }
  [data-state="offline"] .si-daemon-dot { background: #ff7581; box-shadow: 0 0 0 4px rgba(255, 117, 129, .1); }
  [data-state="restored"] { border-color: rgba(85, 226, 166, .34); }
  @keyframes si-pulse { 50% { opacity: .4; transform: scale(.78); } }
  @media (max-width: 420px) {
    .si-daemon-card { width: calc(100vw - 24px); }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-state="scanning"] .si-daemon-dot { animation: none; }
  }
`;
