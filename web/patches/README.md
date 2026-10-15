# Vidstack Slider Preview Cleanup

`@vidstack/react@1.15.6` queues slider preview placement with an animation-frame
throttle. If the player unmounts before that frame, the callback reads the
destroyed slider's props before checking whether its own element still exists.
Repeated canvas video activation and offscreen cleanup reproduced
`TypeError: disabled is not a function` in a real Chrome browser.

The patch returns before reading slider state when the preview is detached.
It covers the package's development, production and server exports, changes no
playback controls, and is applied by Bun's `patchedDependencies`. The root
Dockerfile copies this directory before the frozen install.

Regression: `bun run test:canvas:interaction` plays a local synthetic video,
switches sources and nodes, pans offscreen, changes canvases and runs ten cycles.
Any browser exception fails the run. Reevaluate this patch when updating Vidstack;
do not silently drop it or patch only a local `node_modules` checkout.
