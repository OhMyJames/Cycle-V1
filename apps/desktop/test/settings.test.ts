import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentConfig } from "@cycle/ui";
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

test("a file that is not JSON does not keep the app from opening: it is kept beside, and this computer is what is left", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  await writeFile(path, "{ not json");
  expect(await fileSettings(path).load()).toEqual([LOCAL_ENVIRONMENT]);
  expect(await readFile(`${path}.broken`, "utf8")).toBe("{ not json");
});

test("an address ssh would read as an option is not an environment, and is left as it was", async () => {
  const entry = {
    id: "x",
    name: "X",
    kind: "remote",
    transport: { type: "ssh", host: "-oProxyCommand=touch /tmp/x" },
  };
  const path = await fileIn({ environments: [entry] });
  const settings = fileSettings(path);
  expect(await settings.load()).toEqual([LOCAL_ENVIRONMENT]);
  await settings.save([LOCAL_ENVIRONMENT]);
  expect(JSON.parse(await readFile(path, "utf8")).environments).toEqual([entry]);
});

test("saves made at once are all written, one after the other", async () => {
  const path = await fileIn();
  const settings = fileSettings(path);
  await settings.load();
  const box = (n: number): EnvironmentConfig => ({
    id: `box${n}`,
    name: `Box ${n}`,
    kind: "remote",
    transport: { type: "ssh", host: `box${n}` },
  });
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      settings.save([LOCAL_ENVIRONMENT, ...[1, 2, 3, 4, 5].slice(0, n).map(box)]),
    ),
  );
  expect(JSON.parse(await readFile(path, "utf8")).environments).toHaveLength(5);
});

test("what an entry has that this version does not know, and the other keys of the file, are written back", async () => {
  const path = await fileIn({
    theme: "dark",
    environments: [
      {
        id: "far",
        name: "Far",
        kind: "remote",
        icon: "box",
        transport: { type: "ssh", host: "far", port: 2222 },
      },
    ],
  });
  const settings = fileSettings(path);
  const [, far] = await settings.load();
  // Unchanged: as it was. Renamed: what we know changes, and the rest of the file stays.
  await settings.save([LOCAL_ENVIRONMENT, far as never]);
  const same = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(same.theme).toBe("dark");
  expect((same.environments as unknown[])[0]).toEqual({
    id: "far",
    name: "Far",
    kind: "remote",
    icon: "box",
    transport: { type: "ssh", host: "far", port: 2222 },
  });
});

test("a command that is not a list of words leaves the entry as it is, and not running something else", async () => {
  const entry = {
    id: "far",
    name: "Far",
    kind: "remote",
    transport: { type: "ssh", host: "far", command: "cycle proxy" },
  };
  const path = await fileIn({ environments: [entry] });
  const settings = fileSettings(path);
  expect(await settings.load()).toEqual([LOCAL_ENVIRONMENT]);
  await settings.save([LOCAL_ENVIRONMENT]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ environments: [entry] });
});

test("an entry that says it is local but is not this computer is not a second way in", async () => {
  const laptop = { id: "laptop", name: "Laptop", kind: "local" };
  const path = await fileIn({ environments: [laptop] });
  expect((await fileSettings(path).load()).map((e) => e.id)).toEqual(["local"]);
});

test("an environment saved with the id of an entry that cannot be read is the one that stays", async () => {
  const path = await fileIn({ environments: [{ id: "ssh-box", name: "Odd", kind: "cloud" }] });
  const settings = fileSettings(path);
  await settings.load();
  await settings.save([
    LOCAL_ENVIRONMENT,
    { id: "ssh-box", name: "Box", kind: "remote", transport: { type: "ssh", host: "box" } },
  ]);
  const written = JSON.parse(await readFile(path, "utf8")) as { environments: { name: string }[] };
  expect(written.environments.map((e) => e.name)).toEqual(["Box"]);
});
