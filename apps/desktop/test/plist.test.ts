import { expect, test } from "bun:test";
import { removePlistDict, setPlistString } from "../scripts/plist.ts";

const xml = `<?xml version="1.0"?>
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>Electron</string>
\t<key>ElectronAsarIntegrity</key>
\t<dict>
\t\t<key>Resources/default_app.asar</key>
\t\t<dict><key>algorithm</key><string>SHA256</string></dict>
\t</dict>
\t<key>LSMinimumSystemVersion</key>
\t<string>12.0</string>
</dict>
</plist>`;

test("sets a key that is there, and adds one that is not, escaping the value", () => {
  const set = setPlistString(
    setPlistString(xml, "CFBundleName", "Cycle & Co"),
    "CFBundleDisplayName",
    "Cycle",
  );
  expect(set).toContain("<key>CFBundleName</key>\n\t<string>Cycle &amp; Co</string>");
  expect(set).toContain("<key>CFBundleDisplayName</key>\n\t<string>Cycle</string>");
  expect(set).toContain("<key>LSMinimumSystemVersion</key>"); // the rest is untouched
});

test("removes the asar integrity dict and nothing around it", () => {
  const out = removePlistDict(xml, "ElectronAsarIntegrity");
  expect(out).not.toContain("ElectronAsarIntegrity");
  expect(out).not.toContain("default_app.asar");
  expect(out).toContain("CFBundleName");
  expect(out).toContain("LSMinimumSystemVersion");
  expect(removePlistDict(out, "ElectronAsarIntegrity")).toBe(out);
  // What is left is still well formed: every <dict> closed.
  expect(out.match(/<dict>/g)?.length).toBe(out.match(/<\/dict>/g)?.length);
});
