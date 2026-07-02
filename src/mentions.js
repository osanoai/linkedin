import { UsageError } from './errors.js';

/**
 * Inline mention syntax, embedded anywhere in the post text:
 *
 *   @[Display Name](urn:li:person:AbC123)
 *   @[Company Name](urn:li:organization:12345)
 *
 * The marker is replaced with just "Display Name" in the rendered text, and a
 * UGC `attributes` annotation is generated covering that range so LinkedIn
 * renders it as a real, linked mention.
 */
const MENTION_RE = /@\[([^\]]+)\]\((urn:li:[a-zA-Z]+:[^)\s]+)\)/g;

export function parseMentions(rawText) {
  const attributes = [];
  let text = '';
  let lastIndex = 0;
  for (const match of rawText.matchAll(MENTION_RE)) {
    const [full, name, urn] = match;
    text += rawText.slice(lastIndex, match.index);
    const start = text.length;
    text += name;
    lastIndex = match.index + full.length;

    let value;
    if (urn.startsWith('urn:li:person:')) {
      value = { 'com.linkedin.common.MemberAttributedEntity': { member: urn } };
    } else if (urn.startsWith('urn:li:organization:') || urn.startsWith('urn:li:company:')) {
      const orgUrn = urn.replace('urn:li:company:', 'urn:li:organization:');
      value = { 'com.linkedin.common.CompanyAttributedEntity': { company: orgUrn } };
    } else {
      throw new UsageError(
        `Unsupported mention URN "${urn}". Use urn:li:person:{id} for members or urn:li:organization:{id} for companies.`
      );
    }
    attributes.push({ start, length: name.length, value });
  }
  text += rawText.slice(lastIndex);
  return { text, attributes };
}
