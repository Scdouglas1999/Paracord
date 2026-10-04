/**
 * The server's Overview (docs/index-spec.md §8.1): the first page a server opens
 * from its sidebar header. `ServerHome` is the page; the rest of this folder is its
 * parts (the bar, the banner, the widgets, the feed) and `ServerPage`, the
 * large-title page with the server's hue that Events, Sports, Daily word and Game
 * servers share.
 */
export { ServerHome, type ServerHomeProps } from './ServerHome';
export { ServerPage, type ServerPageProps } from './ServerPage';
