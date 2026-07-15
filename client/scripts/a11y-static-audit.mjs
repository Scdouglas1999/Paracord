import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("src");
const sourceExtensions = new Set([".tsx", ".jsx"]);
const failures = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath);
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      await auditFile(fullPath);
    }
  }
}

function lineNumberFor(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function hasExplicitAccessibleName(openingTag) {
  return /\saria-label\s*=/.test(openingTag) ||
    /\saria-labelledby\s*=/.test(openingTag);
}

function hasTitleAttribute(openingTag) {
  return /\stitle\s*=/.test(openingTag);
}

function hasLikelyIconButtonClass(openingTag) {
  const classMatch = openingTag.match(/\sclassName\s*=\s*(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\})/);
  const className = classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "";
  return /\b(?:icon-btn|command-icon-btn|hover-action-btn)\b/.test(className);
}

function hasDialogRole(openingTag) {
  return /\srole\s*=\s*(?:"(?:dialog|alertdialog)"|'(?:dialog|alertdialog)'|\{\s*["'](?:dialog|alertdialog)["']\s*\})/.test(openingTag) ||
    /\srole\s*=\s*\{\s*role\s*\}/.test(openingTag);
}

function hasDialogAccessibleName(openingTag) {
  return /\saria-label\s*=/.test(openingTag) || /\saria-labelledby\s*=/.test(openingTag);
}

function hasFocusableDialogContainer(openingTag) {
  return /\stabIndex\s*=\s*\{\s*-1\s*\}/.test(openingTag) ||
    /\stabindex\s*=\s*(?:"-1"|'-1')/.test(openingTag);
}

function literalAriaLabelledBy(openingTag) {
  return openingTag.match(/\saria-labelledby\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
}

function hasMenuRole(openingTag) {
  return /\srole\s*=\s*(?:"menu"|'menu'|\{\s*["']menu["']\s*\})/.test(openingTag);
}

function hasClickHandler(openingTag) {
  return /\sonClick\s*=/.test(openingTag);
}

function hasStopPropagationClick(openingTag) {
  return /stopPropagation\s*\(/.test(openingTag);
}

function hasBackdropClass(openingTag) {
  const classMatch = openingTag.match(/\sclassName\s*=\s*(?:"([^"]+)"|'([^']+)'|\{`([^`]+)`\})/s);
  const className = classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "";
  return /\bmodal-backdrop\b/.test(className) ||
    /\bmodal-overlay\b/.test(className) ||
    /\bfixed\b/.test(className) && /\binset-0\b/.test(className) ||
    /position\s*:\s*['"]fixed['"]/.test(openingTag) && /\binset\s*:\s*0\b/.test(openingTag);
}

function hasInteractiveRole(openingTag) {
  return /\srole\s*=\s*(?:"(?:button|link|menuitem|tab|switch|checkbox|radio|treeitem)"|'(?:button|link|menuitem|tab|switch|checkbox|radio|treeitem)'|\{\s*["'](?:button|link|menuitem|tab|switch|checkbox|radio|treeitem)["']\s*\})/.test(openingTag);
}

function hasTabIndex(openingTag) {
  return /\stabIndex\s*=/.test(openingTag) || /\stabindex\s*=/.test(openingTag);
}

function hasElementId(source, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\sid\\s*=\\s*(?:"${escaped}"|'${escaped}')`).test(source);
}

function visibleText(buttonSource) {
  return buttonSource
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyIconOnly(buttonSource) {
  return /<svg\b|<[A-Z][A-Za-z0-9]*(?:\s|\/|>)/.test(buttonSource) &&
    visibleText(buttonSource).length === 0;
}

async function auditFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const nativeConfirmPattern = /\b(?:window\.)?confirm\s*\(\s*(?:`|"|')/g;
  for (const match of source.matchAll(nativeConfirmPattern)) {
    failures.push({
      filePath,
      line: lineNumberFor(source, match.index ?? 0),
      message: "native browser confirm() is not allowed in React UI; use the app confirm dialog",
    });
  }

  const buttonPattern = /<button\b[^>]*>[\s\S]*?<\/button>/g;
  for (const match of source.matchAll(buttonPattern)) {
    const buttonSource = match[0];
    const openingTag = buttonSource.match(/^<button\b[^>]*>/)?.[0] ?? "";
    if (!hasExplicitAccessibleName(openingTag) && isLikelyIconOnly(buttonSource)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: "icon-only button is missing aria-label or aria-labelledby",
      });
    }
    if (!hasExplicitAccessibleName(openingTag) && hasTitleAttribute(openingTag) && hasLikelyIconButtonClass(openingTag)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: "title-only icon button is missing aria-label or aria-labelledby",
      });
    }
  }

  const tooltipPattern = /<Tooltip\b[\s\S]*?<\/Tooltip>/g;
  for (const match of source.matchAll(tooltipPattern)) {
    const tooltipSource = match[0];
    const hasInteractiveChild = /<button\b/.test(tooltipSource) ||
      /\srole\s*=\s*(?:"button"|'button'|\{\s*["']button["']\s*\})/.test(tooltipSource);
    if (hasInteractiveChild && !hasExplicitAccessibleName(tooltipSource)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: "Tooltip-wrapped interactive control is missing aria-label or aria-labelledby",
      });
    }
  }

  const menuPattern = /<[A-Za-z][A-Za-z0-9.:-]*\b(?=[^>]*\srole\s*=)[^>]*>/gs;
  for (const match of source.matchAll(menuPattern)) {
    const openingTag = match[0];
    if (hasMenuRole(openingTag) && !hasDialogAccessibleName(openingTag)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: "role=\"menu\" element is missing aria-label or aria-labelledby",
      });
    }
  }

  const nonInteractiveClickPattern = /<(div|span|img|li|section|article)\b(?=[^>]*\sonClick\s*=)[^>]*>/gs;
  for (const match of source.matchAll(nonInteractiveClickPattern)) {
    const openingTag = match[0];
    const localSource = source.slice(match.index ?? 0, (match.index ?? 0) + 500);
    if (!hasClickHandler(openingTag)) continue;
    if (hasBackdropClass(openingTag) || hasStopPropagationClick(openingTag) || /stopPropagation\s*\(/.test(localSource)) continue;
    if (hasInteractiveRole(openingTag) && hasTabIndex(openingTag)) continue;
    failures.push({
      filePath,
      line: lineNumberFor(source, match.index ?? 0),
      message: "non-interactive element has onClick; use a button/link or add role, tabIndex, and accessible name",
    });
  }

  const modalPattern = /<[A-Za-z][A-Za-z0-9.:-]*\b(?=[^>]*\saria-modal\s*=)[^>]*>/gs;
  for (const match of source.matchAll(modalPattern)) {
    const openingTag = match[0];
    if (!hasDialogRole(openingTag)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: "aria-modal element is missing role=\"dialog\" or role=\"alertdialog\"",
      });
    }
    if (!hasDialogAccessibleName(openingTag)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: "aria-modal dialog is missing aria-label or aria-labelledby",
      });
    }
    if (!hasFocusableDialogContainer(openingTag)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: "aria-modal dialog is missing tabIndex={-1} for focus trapping",
      });
    }
    const labelledBy = literalAriaLabelledBy(openingTag);
    if (labelledBy && !hasElementId(source, labelledBy)) {
      failures.push({
        filePath,
        line: lineNumberFor(source, match.index ?? 0),
        message: `aria-labelledby references missing id "${labelledBy}"`,
      });
    }
  }
}

await walk(root);

if (failures.length > 0) {
  console.error("Static accessibility audit failures:");
  for (const failure of failures) {
    console.error(`${path.relative(process.cwd(), failure.filePath)}:${failure.line} - ${failure.message}`);
  }
  process.exit(1);
}

console.log("Static accessibility audit passed: icon-only buttons, title-only icon controls, Tooltip-wrapped interactive controls, menu names, native confirm usage, non-interactive click handlers, modal dialog metadata, focus targets, and literal label references are accessible.");
