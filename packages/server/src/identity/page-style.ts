/**
 * The look the server's own pages share (sign-in, add account, the second step, invitations): the app's default
 * palette, dark unless the browser asks for light, so the first page a browser user sees reads as Wirebench rather than
 * a bare form. Static CSS only: the pages carry no script and load nothing (their CSP allows inline style alone).
 */
export const SERVER_PAGE_STYLE =
  ':root{color-scheme:dark;--bg:#151413;--card:#1c1b19;--fg:#ece9e3;--muted:#a49d93;--line:#2a2724;--field:#696663;' +
  '--accent:#d97757;--accent-hover:#e58c6e;--on-accent:#1a1210;--danger:#e0685f}' +
  '@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#faf9f7;--card:#fff;--fg:#22201d;--muted:#5c564e;' +
  '--line:#e0dcd5;--field:#94908a;--accent:#a94d2b;--accent-hover:#8e3f21;--on-accent:#fff;--danger:#b23b33}}' +
  '*{box-sizing:border-box}' +
  'html{background:var(--bg)}' +
  'body{margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:12vh 16px 32px;' +
  'background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}' +
  'main{width:100%;max-width:24rem;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:28px}' +
  'main.wide{max-width:36rem}' +
  'h1{margin:0 0 4px;font-size:18px;font-weight:600}' +
  'h1+p{margin:0 0 20px;color:var(--muted);font-size:13px}' +
  'p{margin:12px 0}a{color:var(--accent)}' +
  'code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}' +
  'label{display:block;margin:14px 0 6px;font-size:13px;color:var(--muted)}' +
  'input{width:100%;height:34px;padding:0 10px;font:inherit;color:var(--fg);background:var(--bg);' +
  'border:1px solid var(--field);border-radius:6px}' +
  'input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:var(--accent)}' +
  'button,a.method{display:block;width:100%;margin-top:16px;padding:8px 12px;font:inherit;font-weight:500;' +
  'text-align:center;text-decoration:none;border-radius:6px;cursor:pointer;color:var(--fg);background:transparent;' +
  'border:1px solid var(--field)}' +
  'button:hover,a.method:hover{border-color:var(--fg)}' +
  'form button[type=submit]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}' +
  'form button[type=submit]:hover{background:var(--accent-hover);border-color:var(--accent-hover)}' +
  'button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
  '.message{color:var(--danger)}.message:empty{display:none}.hint{color:var(--muted);font-size:13px;margin:6px 0 0}' +
  'ol{padding-left:20px}li{margin:6px 0}';
