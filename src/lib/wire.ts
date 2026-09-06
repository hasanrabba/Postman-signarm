/**
 * Rules about what actually goes on the wire, shared by the sender, the proxy
 * route and the code generators. They lived in three places and disagreed:
 * the proxy dropped the body of a GET while every generated snippet still
 * sent one, so the copied code did something the app never does.
 */

/**
 * A GET or a HEAD carries no body. Some servers do accept one — Elasticsearch
 * asks for it — but fetch() refuses outright ("Request with GET/HEAD method
 * cannot have body"), so the app cannot send one either way.
 */
export function sendsBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}
