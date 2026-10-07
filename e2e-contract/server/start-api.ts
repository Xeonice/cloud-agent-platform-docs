import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const apiRoot = join(root, "api");
const apiRequire = createRequire(join(apiRoot, "apps/api/package.json"));
const port = Number(process.env.CONTRACT_API_PORT ?? 3110);
interface App {
  init(): Promise<void>;
  listen(port: number, host: string): Promise<void>;
  close(): Promise<void>;
  get(token: unknown): { list(): object[] };
}
interface Builder {
  overrideProvider(token: unknown): { useValue(value: unknown): Builder };
  compile(): Promise<{ createNestApplication(): App }>;
}
async function main() {
  const dataRoot = mkdtempSync(join(tmpdir(), "design-v2-cross-repo-"));
  process.chdir(apiRoot);
  Object.assign(process.env, {
    DATA_ROOT: dataRoot,
    DATABASE_URL: join(dataRoot, "platform.sqlite"),
    MIGRATIONS_DIR: join(apiRoot, "drizzle"),
    ACCESS_PASSCODE_AUTO_GENERATE: "false",
    SANDBOX_DEFAULT_PROVIDER: "aio",
    SANDBOX_DEFAULT_IMAGE: "ghcr.io/agent-infra/sandbox:latest",
    SCHEDULER_HOST_CORES: "32",
    SCHEDULER_HOST_RAM_MB: "32768",
    SCHEDULER_SAFETY_MARGIN: "0",
    WORKSPACE_MIN_FREE_BYTES: "0",
  });
  delete process.env.ACCESS_PASSCODE;
  const { Test } = apiRequire("@nestjs/testing") as {
    Test: { createTestingModule(input: { imports: unknown[] }): Builder };
  };
  const { AppModule } = apiRequire(
    join(apiRoot, "apps/api/dist/app.module.js"),
  ) as { AppModule: unknown };
  const { configurePlatformApp } = apiRequire(
    join(apiRoot, "apps/api/dist/bootstrap/configure-app.js"),
  ) as { configurePlatformApp(app: App): void };
  const contracts = apiRequire("@platform/contracts") as Record<
    string,
    unknown
  >;
  const { ProtocolProvider, registryMetadataFixture } = apiRequire(
    join(apiRoot, "acceptance/support/protocol-resources.ts"),
  ) as {
    ProtocolProvider: new () => { name: string; close(): void };
    registryMetadataFixture(): unknown;
  };
  const provider = new ProtocolProvider();
  const registry = {
    defaultProvider: provider.name,
    get: (name: string) => {
      if (name !== provider.name)
        throw new Error(`Unsupported resource fixture: ${name}`);
      return provider;
    },
    has: (name: string) => name === provider.name,
    list: () => [provider],
    register: () => {
      throw new Error("Resource fixture is fixed");
    },
  };
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(contracts.SANDBOX_PROVIDER_REGISTRY)
    .useValue(registry)
    .overrideProvider(contracts.IMAGE_SPEC_REGISTRY)
    .useValue(registryMetadataFixture())
    .compile();
  const app = module.createNestApplication();
  configurePlatformApp(app);
  await app.init();
  // Real connectivity probe connects to actual local endpoints declared by adapters.
  // Only external destination metadata changes; probe and init service remain production.
  const endpoint = createServer((_request, response) =>
    response.end("local model endpoint"),
  );
  await new Promise<void>((done) => endpoint.listen(0, "127.0.0.1", done));
  const address = endpoint.address();
  if (!address || typeof address === "string")
    throw new Error("No endpoint address");
  for (const adapter of app.get(contracts.RUNTIME_ADAPTER_REGISTRY).list()) {
    Object.defineProperty(adapter, "connectivityTargets", {
      value: [`127.0.0.1:${address.port}`],
      configurable: true,
    });
  }
  await app.listen(port, "127.0.0.1");
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => {
      provider.close();
      endpoint.close();
      rmSync(dataRoot, { recursive: true, force: true });
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.write(
    `Design-v2 real Nest + fresh SQLite: http://127.0.0.1:${port}\n`,
  );
}
void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
