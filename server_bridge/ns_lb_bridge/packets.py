"""Bedrock 2193/2225 payloads (no packet header); never guess a newer protocol.

Sources: Mojang 1.26.50 protocol docs and EndstoneMC/bedrock-protocol.
Fake actors have no server Actor object. Removal uses UNIQUE, not runtime ID.
"""
import struct

SUPPORTED_PROTOCOLS = frozenset({2193, 2225})
ADD_ACTOR, REMOVE_ACTOR, SET_ACTOR_DATA, SYNC_ACTOR_PROPERTY = 13, 14, 39, 165


def uint(value):
    if not isinstance(value, int) or not 0 <= value < 1 << 64:
        raise ValueError("Unsigned varint out of range")
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def sint(value, bits=32):
    if not isinstance(value, int) or not -(1 << (bits - 1)) <= value < 1 << (bits - 1):
        raise ValueError("Signed varint out of range")
    return uint((value << 1) ^ (value >> (bits - 1)))


def string(value):
    data = value.encode("utf-8")
    return uint(len(data)) + data


def properties(values):
    # PropertySyncData has independent int and float lists. All our values are int.
    return uint(len(values)) + b"".join(uint(index) + sint(value) for index, value in values) + b"\x00"


def schema(actor_type, definitions):
    """Network little-endian NBT root; no byte-array length prefix."""
    def tag(kind, name, payload):
        return bytes([kind]) + string(name) + payload
    entries = []
    for name, definition in definitions.items():
        lo, hi = definition["range"]
        entries.append(tag(8, "name", string(name)) + tag(3, "type", sint(0)) +
                       tag(3, "min", sint(lo)) + tag(3, "max", sint(hi)) + b"\x00")
    return (b"\x0a\x00" + tag(8, "type", string(actor_type)) +
            tag(9, "properties", b"\x0a" + sint(len(entries)) + b"".join(entries)) + b"\x00")


def add_actor(unique_id, runtime_id, actor_type, position, yaw, values, protocol=2193):
    if protocol not in SUPPORTED_PROTOCOLS:
        raise ValueError(f"Unsupported leaderboard protocol {protocol}")
    # Stationary, silent, no AI; gravity/collision flags remain unset.
    # Protocol 2168+ requires both the variant index and the restated payload
    # type. Omitting the second Int64 (7) makes clients misread the flags.
    metadata = uint(1) + uint(0) + b"\x07\x07" + sint((1 << 16) | (1 << 17), 64)
    return (sint(unique_id, 64) + uint(runtime_id) + string(actor_type) +
            struct.pack("<10f", *position, 0, 0, 0, 0, yaw, yaw, yaw) +
            b"\x00" + metadata + properties(values) + b"\x00" +
            (b"\x00" if protocol == 2225 else b""))  # Optional passenger-of-block data.


def remove_actor(unique_id):
    return sint(unique_id, 64)


def set_actor_data(runtime_id, values):
    # Static client-only actors have no input simulation; use the default tick.
    return uint(runtime_id) + b"\x00" + properties(values) + b"\x00"
