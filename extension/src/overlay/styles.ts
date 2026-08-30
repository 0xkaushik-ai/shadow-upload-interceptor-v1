export const overlayStyles = `
  :host { all: initial; color-scheme: dark; }
  *, *::before, *::after { box-sizing: border-box; }
  .si-scrim {
    position: fixed; inset: 0; display: grid; place-items: center; padding: 24px;
    background: rgba(3, 6, 9, .72); backdrop-filter: blur(7px);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .si-backdrop { position: absolute; inset: 0; width: 100%; border: 0; background: transparent; cursor: default; }
  .si-card {
    position: relative; width: min(440px, 100%); overflow: hidden;
    border: 1px solid #2b3740; border-radius: 20px; padding: 23px;
    background: linear-gradient(180deg, #111820 0%, #0f151b 100%); color: #f5f7f9;
    box-shadow: 0 34px 100px rgba(0, 0, 0, .56), inset 0 1px rgba(255, 255, 255, .025);
    text-align: left;
  }
  .si-brand { display: flex; align-items: center; font-size: 13px; font-weight: 720; }
  .si-brand-mark {
    display: grid; width: 25px; height: 25px; place-items: center; margin-right: 8px;
    border: 1px solid rgba(85, 226, 166, .4); border-radius: 8px;
    background: rgba(85, 226, 166, .09); color: #5be0a8;
  }
  .si-brand-mark svg { width: 15px; }
  .si-brand-ai { color: #5be0a8; }
  .si-divider { height: 1px; margin: 18px -23px 24px; background: #222d35; }
  .si-alert-row { display: flex; align-items: center; gap: 11px; }
  .si-alert-mark {
    display: grid; width: 44px; height: 44px; flex: 0 0 auto; place-items: center;
    border: 1px solid rgba(255, 105, 118, .28); border-radius: 13px;
    background: rgba(255, 91, 106, .1); color: #ff7581;
  }
  .si-alert-mark svg { width: 26px; }
  .si-finding {
    border: 1px solid rgba(255, 105, 118, .2); border-radius: 999px; padding: 5px 9px;
    background: rgba(255, 91, 106, .06); color: #ff8b95;
    font-size: 9px; font-weight: 760; letter-spacing: .08em; text-transform: uppercase;
  }
  svg { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  h1 { margin: 17px 0 8px; color: #f6f8fa; font-size: 25px; line-height: 1.2; letter-spacing: -.035em; }
  p { margin: 0; color: #9ca8b2; font-size: 13.5px; line-height: 1.65; }
  p strong { color: #e5eaee; font-weight: 650; overflow-wrap: anywhere; }
  .si-assurance {
    display: flex; align-items: center; gap: 10px; margin-top: 18px;
    border: 1px solid rgba(85, 226, 166, .13); border-radius: 11px; padding: 11px 12px;
    background: rgba(85, 226, 166, .045);
  }
  .si-assurance-mark {
    display: grid; width: 25px; height: 25px; flex: 0 0 auto; place-items: center;
    border-radius: 50%; background: rgba(85, 226, 166, .1); color: #60e3ad;
  }
  .si-assurance-mark svg { width: 14px; stroke-width: 2; }
  .si-assurance > span:last-child { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .si-assurance strong { color: #dce6e1; font-size: 11px; font-weight: 680; }
  .si-assurance small { color: #73827b; font-size: 9px; line-height: 1.4; }
  .si-primary {
    width: 100%; margin-top: 20px; border: 0; border-radius: 10px; padding: 11px 16px;
    background: #58dfa7; color: #07110d; cursor: pointer; font: inherit;
    font-size: 13px; font-weight: 760;
    box-shadow: 0 8px 24px rgba(47, 209, 139, .1);
    transition: background 130ms ease, box-shadow 130ms ease, transform 130ms ease;
  }
  .si-primary:hover { transform: translateY(-1px); background: #6ce8b4; box-shadow: 0 10px 28px rgba(47, 209, 139, .16); }
  .si-primary:focus-visible { outline: 2px solid #d7ffed; outline-offset: 3px; }
  .si-footnote {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-top: 13px; color: #65727d; font-size: 9px;
  }
  .si-footnote span:last-child { color: #55616b; }
  kbd {
    border: 1px solid #303a42; border-radius: 4px; padding: 1px 4px;
    background: #171e24; color: #7d8993; font: inherit;
  }
  @media (max-width: 420px) {
    .si-card { padding: 20px; }
    .si-divider { margin-right: -20px; margin-left: -20px; }
    .si-footnote { justify-content: center; }
    .si-footnote span:last-child { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .si-primary { transition: none; } }
`;
