const assetCodePattern = "(?:CHR|SCN|PRP|SPC|AUD)-(?:D[0-9]{3,}-[0-9]{3,}|[0-9a-f]{12}-[0-9a-f]{32}|[0-9]+)";
const variantSuffixPattern = "-V(?:[0-9a-f]{32}|[0-9]+)";
const referencePattern = `${assetCodePattern}(?:${variantSuffixPattern})?`;

export function productionAssetCodes(text: string, mentionsOnly = false): string[] {
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${mentionsOnly ? "@" : "@?"}(${referencePattern})(?![A-Za-z0-9_-])`, "g");
    return [...new Set(Array.from(text.matchAll(pattern), match => match[1]))];
}

export function productionAssetBaseCode(code: string): string {
    return code.replace(new RegExp(`${variantSuffixPattern}$`), "");
}
