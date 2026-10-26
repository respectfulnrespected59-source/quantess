// T-LINK: a server-sent-events reader for the site's answer stream, treated as hostile (security
// model 7): every line and every event is bounded, and on the first breach it stops for good - the caller drops the
// connection and reconnects, rather than buffering whatever the other end sends.

/**
 * @param {{ onEvent: (e: { event: string, data: string }) => void, onError?: (why: string) => void,
 *   maxLine?: number, maxEvent?: number }} options
 * @returns {{ push(chunk: string): void }}
 */
export function createSseParser({ onEvent, onError = () => {}, maxLine = 65_536, maxEvent = 65_536 }) {
  let buffer = '';
  let event = 'message';
  let data = [];
  let size = 0;
  let failed = false;

  const fail = (why) => {
    failed = true;
    buffer = '';
    data = [];
    onError(why);
  };

  const line = (text) => {
    if (text === '') {
      if (data.length) onEvent({ event, data: data.join('\n') });
      event = 'message';
      data = [];
      size = 0;
      return;
    }
    if (text.startsWith(':')) return;                       // a comment: the server's keep-alive
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const value = colon === -1 ? '' : text.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') {
      size += value.length + 1;
      if (size > maxEvent) return fail('event too large');
      data.push(value);
    }
    // id / retry are not used: the CLI decides when and how to reconnect
  };

  return {
    push(chunk) {
      if (failed) return;
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1 && !failed) {
        const text = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (text.length > maxLine) return fail('line too long');
        line(text);
        nl = buffer.indexOf('\n');
      }
      if (!failed && buffer.length > maxLine) fail('line too long');
    }
  };
}
