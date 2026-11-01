#!/usr/bin/env python3
"""Extract a profile-0 signed Shortcut and compare its workflow to an original.

Read-only: no network calls, workflow execution, keychain access, or extraction
to filesystem paths from an archive. Supports uncompressed, zlib and LZFSE
streams containing LZVN/raw blocks. Other AEA profiles/compression fail closed.

This checks the actual archived plist, not just AEA1 magic. It DOES NOT verify
Apple certificate trust, CMS/ECDSA signatures, or AEA HMACs, and does not prove
that an iPhone will import or execute the shortcut successfully.

Format references:
https://github.com/0xilis/libshortcutsign/blob/main/extract.c
https://github.com/0xilis/libNeoAppleArchive/blob/main/libNeoAppleArchive/neo_aea_archive.c
https://github.com/0xilis/libNeoAppleArchive/blob/main/libNeoAppleArchive/neo_aa_header.c
https://github.com/lzfse/lzfse/blob/master/src/lzvn_decode_base.c

The LZVN decoding follows Apple's BSD-3-Clause reference implementation:
Copyright (c) 2015-2016, Apple Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:
1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder(s) nor the names of any contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import struct
import sys
import zlib

MAX_BYTES = 64 * 1024 * 1024
MAX_WORKFLOW_BYTES = 16 * 1024 * 1024


class VerificationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def section(data: bytes, offset: int, length: int) -> bytes:
    require(0 <= offset <= len(data) and 0 <= length <= len(data) - offset,
            "Truncated or oversized container section")
    return data[offset:offset + length]


def lzvn_decode(payload: bytes, expected_size: int) -> bytes:
    require(0 <= expected_size <= MAX_BYTES, "Invalid LZVN output size")
    pos, distance = 0, 0
    out = bytearray()

    def take(length: int) -> bytes:
        nonlocal pos
        value = section(payload, pos, length)
        pos += length
        return value

    while pos < len(payload):
        op = take(1)[0]
        if op == 0x06:
            take(7)
            require(pos == len(payload) and len(out) == expected_size,
                    "LZVN output size or trailing-data mismatch")
            return bytes(out)
        if op in (0x0E, 0x16):
            continue
        require(not (0x70 <= op < 0x80 or 0xD0 <= op < 0xE0
                     or op in (0x1E, 0x26, 0x2E, 0x36, 0x3E)),
                "Undefined LZVN opcode")
        literal = match = 0
        if op >= 0xF0:
            match = take(1)[0] + 16 if op == 0xF0 else op & 15
        elif op >= 0xE0:
            literal = take(1)[0] + 16 if op == 0xE0 else op & 15
        elif 0xA0 <= op < 0xC0:
            word = int.from_bytes(take(2), "little")
            literal = (op >> 3) & 3
            match = (((op & 7) << 2) | (word & 3)) + 3
            distance = word >> 2
        else:
            literal, match = op >> 6, ((op >> 3) & 7) + 3
            mode = op & 7
            if mode < 6:
                distance = (mode << 8) | take(1)[0]
            elif mode == 7:
                distance = int.from_bytes(take(2), "little")
        require(len(out) + literal + match <= expected_size,
                "LZVN output exceeds declared size")
        out.extend(take(literal))
        if match:
            require(1 <= distance <= len(out), "Invalid LZVN back-reference")
            for _ in range(match):
                out.append(out[-distance])
    raise VerificationError("LZVN end-of-stream marker missing")


def lzfse_decode(data: bytes, expected_size: int) -> bytes:
    """Handle the raw/LZVN block types used by small signed Shortcuts."""
    out = bytearray()
    pos = 0
    while pos < len(data):
        magic = section(data, pos, 4)
        pos += 4
        if magic == b"bvx$":
            require(pos == len(data) and len(out) == expected_size,
                    "LZFSE size or trailing-data mismatch")
            return bytes(out)
        if magic == b"bvx-":
            raw_size = int.from_bytes(section(data, pos, 4), "little")
            pos += 4
            require(len(out) + raw_size <= expected_size, "LZFSE raw block too large")
            out.extend(section(data, pos, raw_size))
            pos += raw_size
        elif magic == b"bvxn":
            raw_size, compressed_size = struct.unpack("<II", section(data, pos, 8))
            pos += 8
            require(len(out) + raw_size <= expected_size, "LZVN block too large")
            out.extend(lzvn_decode(section(data, pos, compressed_size), raw_size))
            pos += compressed_size
        elif magic == b"bvx2":
            # Bound a single v2 block before entering the optional native decoder.
            # This deliberately rejects multi-block FSE streams instead of relying
            # on declarations controlled by an external signer for allocation.
            require(pos == 4 and not out, "Only a single LZFSE v2 block is supported")
            raw_size = int.from_bytes(section(data, pos, 4), "little")
            packed0, packed1, packed2 = struct.unpack("<QQQ", section(data, pos + 4, 24))
            header_size = packed2 & 0xFFFFFFFF
            literal_bytes = (packed0 >> 20) & 0xFFFFF
            match_bytes = (packed1 >> 40) & 0xFFFFF
            block_end = header_size + literal_bytes + match_bytes
            require(raw_size == expected_size and 32 <= header_size <= len(data),
                    "LZFSE v2 output/header bounds mismatch")
            require(block_end + 4 == len(data) and section(data, block_end, 4) == b"bvx$",
                    "LZFSE v2 block/trailing-data bounds mismatch")
            # Use an existing optional decoder if available; never install or
            # download dependencies implicitly during verification.
            try:
                import lzfse  # type: ignore[import-not-found]
            except ImportError as error:
                raise VerificationError("LZFSE v1/v2 needs the optional lzfse decoder; no payload verification performed") from error
            decoded = lzfse.decompress(data)
            require(len(decoded) == expected_size, "LZFSE decoded size mismatch")
            return decoded
        else:
            raise VerificationError("Unsupported LZFSE block")
    raise VerificationError("LZFSE end-of-stream marker missing")


def decompress_segment(data: bytes, original_size: int, algorithm: int) -> bytes:
    if algorithm == ord("-") or len(data) == original_size:
        decoded = data
    elif algorithm == ord("e"):
        decoded = lzfse_decode(data, original_size)
    elif algorithm == ord("z"):
        decoder = zlib.decompressobj()
        decoded = decoder.decompress(data, original_size + 1)
        require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail,
                "Invalid zlib stream")
    else:
        raise VerificationError("Unsupported AEA compression algorithm")
    require(len(decoded) == original_size, "AEA segment decoded-size mismatch")
    return decoded


def extract_aea(data: bytes) -> tuple[bytes, dict]:
    require(12 <= len(data) <= MAX_BYTES and data[:4] == b"AEA1", "Not a bounded AEA1 file")
    profile_word, auth_size = struct.unpack("<II", section(data, 4, 8))
    require(profile_word == 0, "Only unencrypted, signed AEA profile 0 is supported")
    auth = plistlib.loads(section(data, 12, auth_size))
    require(isinstance(auth, dict), "AEA authentication data is not a plist dictionary")
    # Header12, auth data, fixed ECDSA slot128, public profile seed32,
    # derivation salt32 and root-header HMAC32, then root header48.
    root_pos = 12 + auth_size + 128 + 32 + 64
    original_size, encoded_size, segment_size, segment_count, compression, checksum = struct.unpack(
        "<QQIIBB", section(data, root_pos, 26))
    require(0 < original_size <= MAX_BYTES and encoded_size == len(data), "AEA root size mismatch")
    require(0 < segment_size <= MAX_BYTES and 0 < segment_count <= 4096,
            "AEA segment dimensions exceed supported bounds")
    require(checksum in (0, 2), "Unsupported AEA segment checksum")
    checksum_size = 32 if checksum == 2 else 0
    segment_header_size = 8 + checksum_size
    pos = root_pos + 48 + 32  # root header followed by cluster0-header HMAC
    out = bytearray()
    clusters = segments = 0
    while pos < len(data):
        clusters += 1
        require(clusters <= 128, "Too many AEA clusters")
        headers = section(data, pos, segment_count * segment_header_size)
        pos += len(headers)
        section(data, pos, 32 * (1 + segment_count))  # next-cluster + segment HMACs
        pos += 32 * (1 + segment_count)
        found_empty = False
        for index in range(segment_count):
            off = index * segment_header_size
            raw_size, compressed_size = struct.unpack("<II", headers[off:off + 8])
            if compressed_size == 0:
                require(raw_size == 0, "Empty AEA segment declares nonempty output")
                found_empty = True
                continue
            require(not found_empty, "Nonempty AEA segment follows an empty segment")
            require(0 < raw_size <= segment_size and len(out) + raw_size <= original_size,
                    "AEA segment exceeds declared output")
            encoded = section(data, pos, compressed_size)
            pos += compressed_size
            decoded = decompress_segment(encoded, raw_size, compression)
            if checksum == 2:
                require(hashlib.sha256(decoded).digest() == headers[off + 8:off + 40],
                        "AEA segment SHA-256 mismatch")
            out.extend(decoded)
            segments += 1
        if found_empty:
            require(pos == len(data), "Unexpected bytes after final AEA cluster")
    require(pos == len(data) and len(out) == original_size, "AEA total output size mismatch")
    return bytes(out), {"profile": 0, "clusters": clusters, "segments": segments,
                        "segment_sha256_verified": checksum == 2,
                        "compression": chr(compression), "archive_bytes": len(out),
                        "signing_certificate_chain_present": "SigningCertificateChain" in auth}


def extract_workflow(archive: bytes) -> tuple[bytes, list[str]]:
    pos = 0
    selected = None
    paths = []
    field_lengths = {"1": 1, "2": 2, "4": 4, "8": 8, "A": 2, "B": 4, "C": 8,
                     "F": 4, "G": 20, "H": 32, "I": 48, "J": 64, "S": 8, "T": 12, "*": 0}
    while pos < len(archive):
        require(section(archive, pos, 4) in (b"AA01", b"YAA1"), "Unsupported Apple Archive entry")
        header_size = int.from_bytes(section(archive, pos + 4, 2), "little")
        require(header_size >= 6, "Invalid Apple Archive header length")
        header = section(archive, pos, header_size)
        cursor = 6
        fields: dict[bytes, bytes] = {}
        blobs = []
        while cursor < len(header):
            key_and_type = section(header, cursor, 4)
            key, subtype = key_and_type[:3], chr(key_and_type[3])
            require(key not in fields, "Duplicate Apple Archive field")
            cursor += 4
            if subtype == "P":
                length = int.from_bytes(section(header, cursor, 2), "little")
                cursor += 2
            else:
                require(subtype in field_lengths, "Unsupported Apple Archive field type")
                length = field_lengths[subtype]
            value = section(header, cursor, length)
            cursor += length
            fields[key] = value
            if subtype in ("A", "B", "C"):
                blobs.append((key, int.from_bytes(value, "little")))
        require(cursor == len(header), "Apple Archive header boundary mismatch")
        require(b"PAT" in fields and b"TYP" in fields, "Apple Archive entry lacks path/type")
        path = fields[b"PAT"].decode("utf-8")
        paths.append(path)
        require(len(paths) <= 100, "Too many Apple Archive entries")
        pos += header_size
        for key, length in blobs:
            value = section(archive, pos, length)
            pos += length
            if path == "Shortcut.wflow" and key == b"DAT":
                require(fields[b"TYP"] == b"F" and selected is None,
                        "Workflow is not a unique regular archive entry")
                require(0 < length <= MAX_WORKFLOW_BYTES, "Workflow size exceeds supported bounds")
                selected = value
        require(fields[b"TYP"] in (b"D", b"F"), "Unexpected archive item type")
        require(fields[b"TYP"] != b"F" or path == "Shortcut.wflow", "Unexpected extra file in signed Shortcut")
    require(pos == len(archive) and selected is not None, "Shortcut.wflow was not found")
    return selected, paths


def read_workflow(data: bytes) -> dict:
    value = plistlib.loads(data)
    require(isinstance(value, dict) and isinstance(value.get("WFWorkflowActions"), list),
            "Payload is not a Shortcut workflow plist")
    return value


def canonical(value) -> bytes:
    return plistlib.dumps(value, fmt=plistlib.FMT_BINARY, sort_keys=True)


def compare_workflows(expected: dict, actual: dict) -> dict:
    different_keys = sorted(key for key in set(actual) | set(expected)
                            if (key not in actual or key not in expected
                                or canonical({key: actual[key]}) != canonical({key: expected[key]})))
    approved_metadata = set()
    if (isinstance(expected.get("WFWorkflowClientVersion"), str)
            and isinstance(actual.get("WFWorkflowClientVersion"), str)
            and all(part.isdigit() for part in expected["WFWorkflowClientVersion"].split("."))
            and all(part.isdigit() for part in actual["WFWorkflowClientVersion"].split("."))):
        approved_metadata.add("WFWorkflowClientVersion")
    # The Apple signer expands the generator's empty icon to these exact defaults.
    if expected.get("WFWorkflowIcon") == {} and actual.get("WFWorkflowIcon") == {
            "WFWorkflowIconStartColor": 0, "WFWorkflowIconGlyphNumber": 0}:
        approved_metadata.add("WFWorkflowIcon")
    return {"payload_matches_original": canonical(actual) == canonical(expected),
            "all_actions_and_parameters_match": canonical(actual["WFWorkflowActions"]) == canonical(expected["WFWorkflowActions"]),
            "import_questions_match": canonical(actual.get("WFWorkflowImportQuestions", [])) == canonical(expected.get("WFWorkflowImportQuestions", [])),
            "metadata_normalization_only": bool(different_keys) and set(different_keys) <= approved_metadata,
            "differing_top_level_keys": different_keys,
            "unapproved_differing_keys": sorted(set(different_keys) - approved_metadata)}


def verify(signed_path: Path, original_path: Path, allow_metadata: bool = False) -> dict:
    require(signed_path.stat().st_size <= MAX_BYTES, "Signed file is too large")
    require(original_path.stat().st_size <= MAX_WORKFLOW_BYTES, "Original workflow is too large")
    signed = signed_path.read_bytes()
    original_bytes = original_path.read_bytes()
    require(len(original_bytes) <= MAX_WORKFLOW_BYTES, "Original workflow is too large")
    expected = read_workflow(original_bytes)
    archive, metadata = extract_aea(signed)
    actual_bytes, paths = extract_workflow(archive)
    actual = read_workflow(actual_bytes)
    canonical_expected = canonical(expected)
    canonical_actual = canonical(actual)
    comparison = compare_workflows(expected, actual)
    passed = comparison["payload_matches_original"] or (allow_metadata and comparison["metadata_normalization_only"])
    return {"verification_passed": passed, **comparison,
            "signature_trust_verification": "not_performed",
            "iphone_import_execution": "not_tested",
            "signed_sha256": hashlib.sha256(signed).hexdigest(),
            "original_workflow_sha256": hashlib.sha256(canonical_expected).hexdigest(),
            "extracted_workflow_sha256": hashlib.sha256(canonical_actual).hexdigest(),
            "expected_actions": len(expected["WFWorkflowActions"]),
            "extracted_actions": len(actual["WFWorkflowActions"]),
            "archive_paths": paths, **metadata}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--signed", required=True, type=Path)
    parser.add_argument("--original", "--unsigned", required=True, type=Path)
    parser.add_argument("--decoder-path", type=Path,
                        help="Explicit local directory containing an optional lzfse decoder")
    parser.add_argument("--allow-metadata-normalization", action="store_true",
                        help="Permit numeric client-version and empty-icon default normalization only")
    args = parser.parse_args()
    if args.decoder_path:
        sys.path.insert(0, str(args.decoder_path.resolve(strict=True)))
    try:
        result = verify(args.signed, args.original, args.allow_metadata_normalization)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["verification_passed"] else 1
    except (VerificationError, OSError, ValueError, plistlib.InvalidFileException, struct.error) as error:
        print(json.dumps({"payload_matches_original": False, "error": str(error),
                          "signature_trust_verification": "not_performed"}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    sys.exit(main())
