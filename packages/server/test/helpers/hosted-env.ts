/**
 * A hosted server's environment over a test database (hosted edition spec §22.1): everything hosted mode requires,
 * for a test that starts the server through `loadConfig` as an operator would. Every value is a placeholder: the
 * Paddle settings are `test_…`, `pri_test…` and `pdl_ntfset_test…`, the names `app.test` and `site.test`.
 */
import type { TestDatabase } from './database.js';

/** The notification destination's secret the fixtures are signed with; a placeholder, never a real key. */
export const TEST_PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test_placeholder_webhook_secret';
/** The Team seat price the fixtures name (`test/fixtures/paddle/`). */
export const TEST_PADDLE_TEAM_PRICE = 'pri_test_team';
export const TEST_APP_DOMAIN = 'app.test';
export const TEST_SITE_DOMAIN = 'site.test';
/** The entry host, `app.<app-domain>` (spec §21.4), where signup and the webhook live. */
export const TEST_ENTRY_HOST = `app.${TEST_APP_DOMAIN}`;

export interface HostedEnvOptions {
  readonly db: Pick<TestDatabase, 'url' | 'ownerUrl' | 'controlUrl'>;
  readonly dataDir: string;
  readonly port: number;
  /** The internal listener's port (spec §20.6): hosted mode is always `multi`. */
  readonly internalPort: number;
  /** Where the mail goes; a port nothing listens on when the test reads no mail. */
  readonly smtpPort: number;
  /** The browser client, whose sign-in page the signup leads to; it needs a build (`browserBuildFixture`). */
  readonly browserClient?: boolean;
}

export function hostedEnv(options: HostedEnvOptions): Record<string, string> {
  return {
    WIREBENCH_SERVER_MODE: 'hosted',
    WIREBENCH_SERVER_PUBLIC_URL: `https://${TEST_ENTRY_HOST}`,
    WIREBENCH_SERVER_DATABASE_URL: options.db.url,
    WIREBENCH_SERVER_MIGRATION_DATABASE_URL: options.db.ownerUrl,
    WIREBENCH_SERVER_CONTROL_DATABASE_URL: options.db.controlUrl,
    WIREBENCH_SERVER_APP_DOMAIN: TEST_APP_DOMAIN,
    WIREBENCH_SERVER_SITE_DOMAIN: TEST_SITE_DOMAIN,
    WIREBENCH_SERVER_SMTP_URL: `smtp://127.0.0.1:${String(options.smtpPort)}`,
    WIREBENCH_SERVER_SMTP_FROM: `teams@${TEST_SITE_DOMAIN}`,
    // A key made for the test only, which encrypts nothing that outlives it.
    WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
    // Each tenant's audit chain key is derived from it (spec §19.7), so an export verifies offline.
    WIREBENCH_SERVER_AUDIT_CHAIN_KEY: 'placeholder-audit-chain-key-for-tests-only',
    WIREBENCH_SERVER_BROWSER_CLIENT: options.browserClient === true ? 'true' : 'false',
    WIREBENCH_SERVER_INSTANCE_URL: `http://127.0.0.1:${String(options.internalPort)}`,
    WIREBENCH_SERVER_INTERNAL_HOST: '127.0.0.1',
    WIREBENCH_SERVER_PADDLE_ENVIRONMENT: 'sandbox',
    WIREBENCH_SERVER_PADDLE_CLIENT_TOKEN: 'test_placeholdertoken',
    WIREBENCH_SERVER_PADDLE_TEAM_PRICE_ID: TEST_PADDLE_TEAM_PRICE,
    WIREBENCH_SERVER_PADDLE_WEBHOOK_SECRET: TEST_PADDLE_WEBHOOK_SECRET,
    WIREBENCH_SERVER_DATA_DIR: options.dataDir,
    WIREBENCH_SERVER_HOST: '127.0.0.1',
    WIREBENCH_SERVER_PORT: String(options.port),
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  };
}
