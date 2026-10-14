/** The name grammar of `${secret:NAME}`, shared with snippet variables (`snippets.ts`) and env names. */
export const SECRET_NAME = /[A-Za-z_][A-Za-z0-9_]*/;
export const SECRET_TOKEN = new RegExp(`^\\$\\{secret:(${SECRET_NAME.source})\\}$`);
