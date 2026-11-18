// Edits to a macOS Info.plist, as text: Electron's is XML, and doing it here means no plutil, so the
// bundle's layout can be built and tested anywhere.

const xmlEscape = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Sets a string key, adding it if the plist has none. */
export const setPlistString = (xml: string, key: string, value: string): string => {
  const entry = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (entry.test(xml))
    return xml.replace(entry, (_m, open, close) => `${open}${xmlEscape(value)}${close}`);
  const end = xml.lastIndexOf("</dict>");
  if (end === -1) throw new Error("Info.plist has no closing </dict>");
  return `${xml.slice(0, end)}\t<key>${key}</key>\n\t<string>${xmlEscape(value)}</string>\n${xml.slice(end)}`;
};

/** Removes a key and its dict value (Electron's ElectronAsarIntegrity), nested dicts and all, if it is there. */
export const removePlistDict = (xml: string, key: string): string => {
  const start = new RegExp(`\\s*<key>${key}</key>\\s*<dict>`).exec(xml);
  if (start === null) return xml;
  let depth = 1;
  const tag = /<(\/?)dict>/g;
  tag.lastIndex = start.index + start[0].length;
  for (let match = tag.exec(xml); match !== null; match = tag.exec(xml)) {
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return xml.slice(0, start.index) + xml.slice(tag.lastIndex);
  }
  throw new Error(`Info.plist: the dict of ${key} is not closed`);
};
