package model

// Short production codes are separate from UUID storage identities. Keep
// persisted numeric and earlier UUID codes readable without rewriting projects.
const ProductionAssetCodePattern = `(?:CHR|SCN|PRP|SPC|AUD)-(?:D[0-9]{3,}-[0-9]{3,}|[0-9a-f]{12}-[0-9a-f]{32}|[0-9]+)`
const ProductionAssetVariantSuffixPattern = `-V(?:[0-9a-f]{32}|[0-9]+)`
const ProductionAssetReferencePattern = ProductionAssetCodePattern + `(?:` + ProductionAssetVariantSuffixPattern + `)?`
