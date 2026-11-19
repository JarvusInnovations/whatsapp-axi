// The licence gate (specs/distribution.md "Licence" and "Tests"): the daemon's dependency licences
// are classified and checked against the allow-list kept in the repository.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error: a plain ESM script without types
import { check, classify, readAllowList } from "../scripts/daemon-licenses.mjs";

const root = join(import.meta.dirname, "..");
const script = join(root, "scripts", "daemon-licenses.mjs");
const tmp = mkdtempSync(join(tmpdir(), "wa-licenses-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const TEXTS: Record<string, string> = {
  MIT: "MIT License\n\nCopyright (c) 2020 Example\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software",
  ISC: "Copyright (c) 2025 Example\n\nPermission to use, copy, modify, and distribute this software for any purpose\nwith or without fee is hereby granted",
  "BSD-2-Clause":
    "Copyright (c) Example\n\nRedistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:",
  "BSD-3-Clause":
    "Copyright 2009 Example.\n\nRedistribution and use in source and binary forms, with or without modification, are permitted. Neither the name of Example nor the names of its contributors may be used to endorse or promote products",
  "BSD-4-Clause": "Redistribution and use in source and binary forms ... All advertising materials mentioning features ... endorse or promote",
  "Apache-2.0": "                                 Apache License\n                           Version 2.0, January 2004\n",
  "MPL-2.0":
    "Mozilla Public License Version 2.0\n==================================\n... a Secondary License means the GNU General Public License, Version 2.0, the GNU Lesser General Public License ...",
  "GPL-3.0": "                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n ... GNU Affero General Public License ...",
  "GPL-2.0": "                    GNU GENERAL PUBLIC LICENSE\n                       Version 2, June 1991\n",
  "AGPL-3.0": "                    GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007\n",
  "LGPL-2.1": "                  GNU LESSER GENERAL PUBLIC LICENSE\n                       Version 2.1, February 1999\n",
  unknown: "All rights reserved. You may not redistribute this.",
};

describe("classifying a licence file", () => {
  it("names each licence by its text, and a GNU licence by its title only", () => {
    for (const [id, text] of Object.entries(TEXTS)) expect(classify(text), id).toBe(id);
  });

  it("the platform packages' licence text is GPL-3.0", () => {
    expect(classify(readFileSync(join(root, "packaging", "platform", "LICENSE"), "utf-8"))).toBe("GPL-3.0");
  });
});

describe("the allow-list", () => {
  const allow = readAllowList();

  it("the repository's list is compatible with distributing the binary under GPL-3.0", () => {
    expect([...allow.allowed].sort()).toEqual(["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "GPL-3.0", "ISC", "MIT", "MPL-2.0"]);
    for (const bad of ["GPL-2.0", "AGPL-3.0", "BSD-4-Clause", "unknown", "none"]) expect(allow.allowed.has(bad), bad).toBe(false);
  });

  it("marks a dependency whose licence is not allowed, and honours a pinned module", () => {
    const list = [
      { path: "example.org/ok", version: "v1.0.0", license: "MIT" },
      { path: "example.org/bad", version: "v1.0.0", license: "GPL-2.0" },
      { path: "example.org/odd", version: "v1.0.0", license: "unknown" },
    ];
    const plain = check(list, allow) as Array<{ path: string; allowed: boolean }>;
    expect(plain.filter((c) => !c.allowed).map((c) => c.path)).toEqual(["example.org/bad", "example.org/odd"]);
    const pinned = check(list, { allowed: allow.allowed, modules: { "example.org/odd": { license: "MIT", reason: "test" } } }) as Array<{
      path: string;
      allowed: boolean;
    }>;
    expect(pinned.filter((c) => !c.allowed).map((c) => c.path)).toEqual(["example.org/bad"]);
  });
});

describe("the licence check over the real daemon dependencies", () => {
  const hasGo = spawnSync("go", ["version"]).status === 0;

  it.skipIf(!hasGo)("passes with the repository's allow-list", () => {
    const out = execFileSync("node", [script], { encoding: "utf-8" });
    expect(out).toContain("go.mau.fi/libsignal");
    expect(out).toMatch(/ok {2}GPL-3\.0 +go\.mau\.fi\/libsignal/);
    expect(out).toContain("all allowed");
  });

  it.skipIf(!hasGo)("fails, naming the dependency, when its licence is not on the list", () => {
    const list = join(tmp, "allow.json");
    writeFileSync(list, JSON.stringify({ allowed: ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT", "MPL-2.0"], modules: {} }));
    const r = spawnSync("node", [script, "--allow", list], { encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not allowed");
    expect(r.stderr).toMatch(/go\.mau\.fi\/libsignal v\S+: GPL-3\.0/);
  });
});
