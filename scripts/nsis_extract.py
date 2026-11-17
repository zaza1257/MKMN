#!/usr/bin/env python3
"""Read an NSIS installer's embedded payload WITHOUT installing it.

MKMN release gate (Task: installer payload validation). The installer is a solid
LZMA NSIS executable; this tool locates its firstheader, decompresses the payload
stream, parses the compiled script's entries, and emits a manifest of every file
member embedded in it (offset, size, SHA-256). It never writes outside an optional
report file and never executes anything from the installer.

Container format (reverse-engineered and verified against real builds):
  - firstheader: 28 bytes: flags(u32), 0xDEADBEEF, "NullsoftInst", then
    length_of_header(u32) and length_of_all_following_data(u32).
  - 5 bytes of LZMA properties follow, then a raw LZMA1 stream whose
    decompression yields: [u32 headerSize][header bytes][data area].
  - header: dword0 = header size (counts itself), dword1 = flags, then 7 block
    descriptors as (u32 offset, u32 count) pairs; entry/string offsets are
    relative to header+4.
  - entries: <count> records of 7 ints (28 bytes): which, then 6 args.
    which == 20 (EW_EXTRACTFILE) embeds a file: arg3 (offsets[2]) is the
    member's position in the data area.
  - data area: a contiguous sequence of [u32 size][size bytes] members, where
    the position recorded in the entry points AT the size dword; consecutive
    members therefore satisfy next_pos == pos + 4 + size. The exact base of the
    data area (header size + small delta) is auto-detected by requiring this
    chain to hold across nearly all members.

Member names are NOT recovered: NSIS does not store them in a form we decode
reliably (entry strings point at runtime-composed paths). Validation is purely
content-based, which is stronger anyway: a member hash that matches a file on
disk proves that exact file is inside the installer.

Subcommands:
  manifest <installer> [-o manifest.json]
      Parse the installer, write/print the member manifest.
  verify <installer> --source <path> [--source <path> ...] [--json report.json]
      Compare the embedded members against the files that SHOULD be inside
      (every file under each --source path, recursively). Reports:
        - missing:  an expected file whose hash is not in the installer
                    (stale or lost payload - a release blocker)
        - extra:    installer members matching nothing expected (NSIS-generated
                    scripts, the uninstaller, licenses - informational only)
      Exit codes: 0 = every expected file is embedded; 1 = missing/stale;
      2 = the installer could not be parsed.

Stdlib only. Tested with the NSIS 3.x / makensis toolchain MKMN's build uses.
"""

import argparse
import hashlib
import json
import lzma
import os
import struct
import sys

FIRSTHEADER_MAGIC = b"\xef\xbe\xad\xde" + b"NullsoftInst"
EW_EXTRACTFILE = 20
ENTRY_STRUCT = "<7i"  # which + 6 args
ENTRY_SIZE = 28
MAX_DATA_BASE_DELTA = 64  # how far past the declared header size to search for the data area


class ParseError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def find_firstheader(buf):
    """Return (flags, length_of_header, length_of_all, file_offset_of_firstheader)."""
    pos = buf.find(FIRSTHEADER_MAGIC)
    if pos < 4:
        raise ParseError("no NSIS firstheader signature found (not an NSIS installer?)")
    fh = pos - 4
    flags, _, _sig, loh, loa = struct.unpack_from("<II12sII", buf, fh)
    return flags, loh, loa, fh


def lzma_filter_from_props(props):
    """Decode NSIS's 5-byte LZMA properties block (props byte + dict size)."""
    if len(props) < 5:
        raise ParseError("LZMA properties block truncated")
    p = props[0]
    lc = p % 9
    rem = p // 9
    lp = rem % 5
    pb = rem // 5
    dict_size = struct.unpack_from("<I", props, 1)[0]
    if dict_size < 1 << 12:
        dict_size = 1 << 12
    return {"id": lzma.FILTER_LZMA1, "lc": lc, "lp": lp, "pb": pb, "dict_size": dict_size}


def decompress_payload(buf, fh_offset):
    """Decompress the solid stream that follows the firstheader (+5-byte props)."""
    props_at = fh_offset + 28
    filt = lzma_filter_from_props(buf[props_at:props_at + 5])
    dec = lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=[filt])
    out = bytearray()
    chunk_size = 1 << 20
    pos = props_at + 5
    while pos < len(buf) and not dec.eof:
        chunk = buf[pos:pos + chunk_size]
        try:
            out += dec.decompress(chunk)
        except lzma.LZMAError as e:
            # The stream has ended; anything after it belongs to other sections
            # (e.g. the uninstaller archive). What we have is the payload.
            if not out:
                raise ParseError("LZMA decompression failed at start: %s" % e)
            break
        pos += len(chunk)
    return bytes(out)


def parse_entries(header):
    """Return the entries block's records as a list of 7-int tuples."""
    size, flags = struct.unpack_from("<II", header, 0)
    blocks = []
    for k in range(7):
        off, cnt = struct.unpack_from("<II", header, 8 + 8 * k)
        blocks.append((off, cnt))
    # Entries are relative to header+4. Find the block that reads as a plausible
    # entry table: in-bounds records, plausible opcodes, some file extractions.
    best = None
    for off, cnt in blocks:
        base = 4 + off
        if cnt <= 0 or base < 0 or base + cnt * ENTRY_SIZE > len(header):
            continue
        recs = [struct.unpack_from(ENTRY_STRUCT, header, base + ENTRY_SIZE * i)
                for i in range(cnt)]
        extracts = [r for r in recs if r[0] == EW_EXTRACTFILE]
        opcodes_ok = all(0 <= r[0] <= 80 for r in recs)
        score = len(extracts) if opcodes_ok else 0
        if score and (best is None or score > best[0]):
            best = (score, recs)
    if best is None:
        raise ParseError("no plausible entries block found in header")
    return best[1]


def extract_members(dec, entries):
    """Resolve EW_EXTRACTFILE entries to data-area members.

    Returns (members, info) where members is a list of dicts sorted by offset:
      {offset, size, sha256, extractionCount}. info carries integrity stats.
    """
    hdr_size = struct.unpack_from("<I", dec, 0)[0]
    if not (0 < hdr_size < len(dec)):
        raise ParseError("implausible header size %d" % hdr_size)
    claimed = sorted({e[3] for e in entries if e[0] == EW_EXTRACTFILE and e[3] >= 0})
    if not claimed:
        raise ParseError("entries contain no file-extraction records")

    # Auto-detect the data-area base: the first member position that makes the
    # chain rule (next == pos + 4 + size) hold for (nearly) all members.
    best = None
    for delta in range(0, MAX_DATA_BASE_DELTA, 4):
        base = hdr_size + delta
        if base >= len(dec):
            break
        data = dec[base:]
        if max(claimed) + 4 > len(data):
            continue
        sizes_ok = 0
        plausible = True
        for c in claimed:
            if c + 4 > len(data):
                plausible = False
                break
            size = struct.unpack_from("<I", data, c)[0]
            if c + 4 + size > len(data):
                plausible = False
                break
        if not plausible:
            continue
        for a, b in zip(claimed, claimed[1:]):
            size_a = struct.unpack_from("<I", data, a)[0]
            if b == a + 4 + size_a:
                sizes_ok += 1
        if best is None or sizes_ok > best[0]:
            best = (sizes_ok, delta, data)
    if best is None:
        raise ParseError("could not locate the data area (chain rule never holds)")
    chain_ok, delta, data = best
    gaps = len(claimed) - 1

    members = []
    counts = {}
    for e in entries:
        if e[0] == EW_EXTRACTFILE and e[3] >= 0:
            counts[e[3]] = counts.get(e[3], 0) + 1
    for c in claimed:
        size = struct.unpack_from("<I", data, c)[0]
        blob = data[c + 4:c + 4 + size]
        if len(blob) != size:
            raise ParseError("member at +%d overruns the payload" % c)
        members.append({
            "offset": c,
            "size": size,
            "sha256": sha256(blob),
            "extractionCount": counts.get(c, 0),
        })
    info = {
        "headerSize": hdr_size,
        "dataBaseDelta": delta,
        "memberCount": len(members),
        "payloadBytes": sum(m["size"] for m in members),
        "chainHolds": chain_ok,
        "chainGaps": gaps,
        "trailingBytes": len(dec) - (hdr_size + delta) - (
            claimed[-1] + 4 + struct.unpack_from("<I", data, claimed[-1])[0]
        ) if claimed else 0,
    }
    return members, info


def build_manifest(installer_path):
    buf = open(installer_path, "rb").read()
    flags, loh, loa, fh = find_firstheader(buf)
    dec = decompress_payload(buf, fh)
    entries = parse_entries(dec)
    members, info = extract_members(dec, entries)
    return {
        "installer": {
            "path": os.path.abspath(installer_path),
            "size": len(buf),
            "sha256": sha256(buf),
            "firstheaderOffset": fh,
            "lengthOfHeader": loh,
            "lengthOfAllFollowingData": loa,
            "decompressedBytes": len(dec),
        },
        "container": info,
        "members": members,
    }


def iter_source_files(sources):
    for src in sources:
        if os.path.isfile(src):
            yield src
        elif os.path.isdir(src):
            for root, _dirs, files in os.walk(src):
                for f in files:
                    yield os.path.join(root, f)
        # non-existent sources are silently skipped: the caller decides
        # which components are mandatory (Validate-Installer.ps1 already does)


def cmd_verify(args):
    manifest = build_manifest(args.installer)
    embedded = {}
    for m in manifest["members"]:
        embedded[m["sha256"]] = embedded.get(m["sha256"], 0) + 1

    expected = {}  # sha256 -> [paths]
    expected_count = 0
    for p in iter_source_files(args.source):
        h = sha256(open(p, "rb").read())
        expected.setdefault(h, []).append(p)
        expected_count += 1

    missing = sorted(paths[0] for h, paths in expected.items() if h not in embedded)
    matched = sum(1 for h in expected if h in embedded)
    extra_hashes = [h for h in embedded if h not in expected]
    extra_members = [m for m in manifest["members"] if m["sha256"] in set(extra_hashes)]

    cont = manifest["container"]
    chain_ok = cont["chainHolds"] == cont["chainGaps"]
    report = {
        "installer": manifest["installer"],
        "container": cont,
        "expectedFiles": expected_count,
        "expectedMatched": matched,
        "missing": missing,
        "extraMemberCount": len(extra_members),
        "extraMembers": extra_members[:50],
        "payloadChainIntact": chain_ok,
    }
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)

    print("installer: {size} bytes, sha256 {h}".format(
        size=manifest["installer"]["size"], h=manifest["installer"]["sha256"][:16] + "..."))
    print("payload: {n} members, {b} bytes embedded, chain {c}/{g} gaps intact".format(
        n=cont["memberCount"], b=cont["payloadBytes"],
        c=cont["chainHolds"], g=cont["chainGaps"]))
    print("expected {e} files from {s} source(s): {m} embedded, {mi} MISSING".format(
        e=expected_count, s=len(args.source), m=matched, mi=len(missing)))
    print("installer members matching nothing expected: {x} (NSIS scripts/uninstaller/licenses)".format(
        x=len(extra_members)))
    if missing:
        print("MISSING / STALE payload (first 20):")
        for p in missing[:20]:
            print("  - " + p)
        return 1
    if not chain_ok:
        print("payload member chain is inconsistent - container format mismatch")
        return 1
    return 0


def cmd_manifest(args):
    manifest = build_manifest(args.installer)
    text = json.dumps(manifest, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(text)
        print("manifest written to " + args.output)
    else:
        print(text)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_m = sub.add_parser("manifest", help="dump the embedded member manifest")
    p_m.add_argument("installer")
    p_m.add_argument("-o", "--output")
    p_m.set_defaults(func=cmd_manifest)

    p_v = sub.add_parser("verify", help="verify expected files are embedded")
    p_v.add_argument("installer")
    p_v.add_argument("--source", action="append", required=True,
                     help="file or directory that should be inside (repeatable)")
    p_v.add_argument("--json", help="write the full report as JSON")
    p_v.set_defaults(func=cmd_verify)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except ParseError as e:
        print("PARSE FAILURE: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
