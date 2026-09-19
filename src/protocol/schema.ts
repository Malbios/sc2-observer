import path from "node:path";
import protobuf from "protobufjs";

const VENDOR_DIR = path.join(__dirname, "..", "..", "vendor");

function loadRoot(): protobuf.Root {
  const root = new protobuf.Root();
  // sc2api.proto imports paths like "s2clientprotocol/common.proto"; resolve
  // those against vendor/, but leave the initial absolute file path alone
  // (see spike/proxy.js -- this bug caused a broken import the first time).
  root.resolvePath = (_origin, target) =>
    path.isAbsolute(target) ? target : path.join(VENDOR_DIR, target);
  root.loadSync(path.join(VENDOR_DIR, "s2clientprotocol", "sc2api.proto"), { keepCase: true });
  return root;
}

const root = loadRoot();

export const RequestType = root.lookupType("SC2APIProtocol.Request");
export const ResponseType = root.lookupType("SC2APIProtocol.Response");

// Loose shape -- protobufjs' decoded messages are structurally what we need,
// but generating full static types from these .proto files is more tooling
// than Phase 1 needs. Fields are the snake_case names from the .proto source
// (loaded with keepCase: true).
export type Request = Record<string, any>;
export type Response = Record<string, any>;

export function encodeRequest(fields: Record<string, unknown>): Uint8Array {
  return RequestType.encode(RequestType.create(fields)).finish();
}

export function decodeRequest(bytes: Uint8Array): Request {
  return RequestType.decode(bytes) as unknown as Request;
}

export function decodeResponse(bytes: Uint8Array): Response {
  return ResponseType.decode(bytes) as unknown as Response;
}
