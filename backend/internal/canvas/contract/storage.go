package contract

// Shared by browser saves and Agent writes. HTTP allows a small JSON envelope.
const MaxCanvasPayloadBytes = 100 << 20
const MaxCanvasRequestBytes = MaxCanvasPayloadBytes + (64 << 10)
