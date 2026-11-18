import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSettings, LOCAL_ENVIRONMENT } from "../src/main/settings.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const fileIn = async (content?: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  if (content !== undefined) await writeFile(path, JSON.stringify(content));
  return path;
};

test("no file: this computer, and nothing else", async () => {
  expect(await fileSettings(await fileIn()).load()).toEqual([LOCAL_ENVIRONMENT]);
});

test("the format before environments, a list of hosts, is read as remote environments with the same ids", async () => {
  const path = await fileIn({
    hosts: [
      { id: "ssh-box", name: "Box", kind: "ssh", host: "me@box", command: ["cycle", "proxy"] },
      { id: "ssh-alias", name: "Alias", kind: "ssh", host: "alias" },
    ],
  });
  expect(await fileSettings(path).load()).toEqual([
    LOCAL_ENVIRONMENT,
    {
      id: "ssh-box",
      name: "Box",
      kind: "remote",
      transport: { type: "ssh", host: "me@box", command: ["cycle", "proxy"] },
    },
    { id: "ssh-alias", name: "Alias", kind: "remote", transport: { type: "ssh", host: "alias" } },
  ]);
});

test("what is saved is the new format, and is read back as it was", async () => {
  const path = await fileIn({ hosts: [{ id: "ssh-box", name: "Box", kind: "ssh", host: "box" }] });
  const settings = fileSettings(path);
  const loaded = await settings.load();
  await settings.save(loaded);
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(Object.keys(written)).toEqual(["environments"]);
  expect(written.environments).toEqual([
    { id: "ssh-box", name: "Box", kind: "remote", transport: { type: "ssh", host: "box" } },
  ]);
  expect(await fileSettings(path).load()).toEqual(loaded);
});

test("an entry this version does not understand is not shown, and is not lost when settings are saved", async () => {
  const strange = { id: "cloud-1", name: "Cloud", kind: "cloud", region: "eu" };
  const broken = { id: "no-host", name: "Broken", kind: "ssh" };
  const path = await fileIn({
    environments: [
      strange,
      { id: "far", name: "Far", kind: "remote", transport: { type: "ssh", host: "far" } },
      broken,
    ],
  });
  const settings = fileSettings(path);
  const loaded = await settings.load();
  expect(loaded.map((e) => e.id)).toEqual(["local", "far"]);
  await settings.save([
    ...loaded,
    { id: "new", name: "New", kind: "remote", transport: { type: "ssh", host: "new" } },
  ]);
  const written = JSON.parse(await readFile(path, "utf8")) as { environments: { id: string }[] };
  expect(written.environments.map((e) => e.id)).toEqual(["far", "new", "cloud-1", "no-host"]);
  expect(written.environments).toContainEqual(strange);
  expect(written.environments).toContainEqual(broken);
});

test("this computer is not kept in the file, and an entry that says it is is ignored", async () => {
  const path = await fileIn({ environments: [{ id: "local", name: "Mine", kind: "local" }] });
  const settings = fileSettings(path);
  expect(await settings.load()).toEqual([LOCAL_ENVIRONMENT]);
  await settings.save([LOCAL_ENVIRONMENT]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ environments: [] });
});

test("a file that cannot be read says which, instead of starting from nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  await writeFile(path, "{ not json");
  await expect(fileSettings(path).load()).rejects.toThrow(path);
});
