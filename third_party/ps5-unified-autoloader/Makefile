# ps5-unified-autoloader Makefile

# -----------------------------------------------------------------------
# Tools
# -----------------------------------------------------------------------
SDK    ?= /opt/ps5-payload-sdk
CC     := $(SDK)/bin/prospero-clang
STRIP  := $(SDK)/bin/prospero-strip

# -----------------------------------------------------------------------
# SDK paths
# -----------------------------------------------------------------------
TARGET := $(SDK)/target

# -----------------------------------------------------------------------
# Build config
# -----------------------------------------------------------------------
# -I. lets the compiler find the generated *_elf.c arrays in the project root
INCLUDES := -I. -Iinclude -I$(TARGET)/include
LIBS     := -lSceSystemService -lSceUserService -lSceNetCtl -lpthread
SRCS     := src/main.c src/launcher.c src/app_killer.c src/notification.c src/sync.c src/default_chain.c
CFLAGS   := -Os -Wall -ffunction-sections -fdata-sections
LDFLAGS  := -Wl,--gc-sections

ELF      := autoloader.elf

.PHONY: all clean dist-clean

# Keep the generated arrays and objects between builds: regenerating them
# only because make treats chained-pattern products as intermediates wastes
# a full recompile of ~9 MB of payload data on every invocation.
.PRECIOUS: pldmgr_elf.c kstuff_elf.c smp_elf.c etahen_elf.c etahen_config.c \
           pldmgr_elf.o kstuff_elf.o smp_elf.o etahen_elf.o etahen_config.o

all: $(ELF)

# -----------------------------------------------------------------------
# Default chain payload staging
#
# The default chain (no autoload.txt) embeds these files. They are staged
# into payloads/ by the parent repository's payload-deps target before this
# Makefile runs: kstuff-lite and ShadowMountPlus are fetched from their
# official release repositories at build time, etaHEN and its config
# template are vendored in the parent repo, and Payload Manager is pinned
# to an official release. Each file becomes its own translation unit so
# the compiler never holds every array in one pass.
# -----------------------------------------------------------------------
DEFAULT_DIR  ?= payloads
PLDMGR_ELF   := $(DEFAULT_DIR)/pldmgr.elf
KSTUFF_ELF   := $(DEFAULT_DIR)/kstuff.elf
SMP_ELF      := $(DEFAULT_DIR)/shadowmountplus.elf
ETAHEN_ELF   := $(DEFAULT_DIR)/etaHEN.elf
ETAHEN_CFG   := $(DEFAULT_DIR)/etahen-config.ini

EMBED_SRCS := pldmgr_elf.c kstuff_elf.c smp_elf.c etahen_elf.c etahen_config.c
EMBED_OBJS := $(EMBED_SRCS:.c=.o)

# The generator names the array after the input FILE NAME (non-alphanumeric
# characters become underscores), so generate from the staged copies whose
# canonical names match the symbols default_chain.h declares.
XXD_C := python3 tools/xxd_c.py

%_elf.c: $(DEFAULT_DIR)/%.elf
	@echo "Embedding $<..."
	$(XXD_C) $< $@

etahen_config.c: $(DEFAULT_DIR)/etahen-config.ini
	@echo "Embedding $<..."
	$(XXD_C) $< $@

# Build autoloader.elf — the embedded arrays live in their own objects and
# must NOT be passed again as sources to main.c.
$(ELF): $(SRCS) $(EMBED_OBJS)
	@echo "Building $(ELF)..."
	$(CC) $(CFLAGS) $(INCLUDES) $(LDFLAGS) -o $@ $(SRCS) $(EMBED_OBJS) $(LIBS)
	@echo "Stripping $(ELF)..."
	$(STRIP) $@
	@echo "Done: $(ELF)"

%.o: %.c
	$(CC) $(CFLAGS) $(INCLUDES) -c -o $@ $<

clean:
	rm -f $(ELF) $(EMBED_OBJS) $(EMBED_SRCS)

dist-clean: clean
	rm -rf $(DEFAULT_DIR)
