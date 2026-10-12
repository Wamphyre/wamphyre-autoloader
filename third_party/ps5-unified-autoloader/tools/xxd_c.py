#!/usr/bin/env python3
"""Generate a C byte array from a binary file, xxd -i style.

Usage: xxd_c.py INPUT OUTPUT

The array is named after the input file name with non-alphanumeric
characters replaced by underscores (etaHEN-config.ini -> etaHEN_config_ini),
matching what `xxd -i` would produce, so the generated symbols are the ones
default_chain.h declares.
"""
import re
import sys

if len(sys.argv) != 3:
    print(__doc__, file=sys.stderr)
    sys.exit(1)

src, dst = sys.argv[1], sys.argv[2]
name = re.sub(r"\W", "_", src.split("/")[-1])

with open(src, "rb") as f:
    data = f.read()

with open(dst, "w") as f:
    f.write("unsigned char %s[] = {\n" % name)
    for i in range(0, len(data), 16):
        chunk = data[i:i + 16]
        f.write("  " + " ".join("0x%02x," % b for b in chunk) + "\n")
    f.write("};\n")
    f.write("unsigned int %s_len = %d;\n" % (name, len(data)))
