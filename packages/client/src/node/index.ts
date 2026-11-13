// Node-only parts of @ih/client: saved machines and the SSH forwards that reach them.
export { MachineCatalog, defaultCatalogFile, validateMachine, DEFAULT_REMOTE_PORT, type MachineProfile, type NewMachine } from './catalog.ts';
export { MachineConnection, classifySshFailure, remotePath, sshExtraArgs, tunnelArgs, type AttentionKind, type ConnectionOptions, type ConnectionState, type SpawnTunnel, type TunnelProcess } from './tunnel.ts';
export { Fleet, LOCAL, localEndpointFromEnv, parseScoped, scoped, type Endpoint, type FleetOptions } from './fleet.ts';
export { attachTerminal, DETACH_HINT, type AttachIo, type AttachOptions, type AttachResult } from './terminal.ts';
