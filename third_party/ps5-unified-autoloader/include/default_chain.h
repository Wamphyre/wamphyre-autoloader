/*
 * default_chain.h — the built-in payload chain for unconfigured consoles
 *
 * When no autoload.txt is found, the autoloader does not stop at Payload
 * Manager: it first launches the default chain (kstuff-lite, ShadowMountPlus,
 * etaHEN with its config ensured) and then starts Payload Manager as the
 * manager UI, mirroring what a configured console would load from its own
 * autoload.txt.
 */
#ifndef DEFAULT_CHAIN_H
#define DEFAULT_CHAIN_H

#include <stdint.h>
#include <stddef.h>

/* Embedded payload arrays, generated at build time by xxd from the files
 * staged in payloads/ (see the Makefile). Each lives in its own translation
 * unit so the compiler never has to hold every array in one go. */
extern const uint8_t kstuff_elf[];
extern const unsigned int kstuff_elf_len;

extern const uint8_t smp_elf[];
extern const unsigned int smp_elf_len;

extern const uint8_t etahen_elf[];
extern const unsigned int etahen_elf_len;

extern const uint8_t etahen_config_ini[];
extern const unsigned int etahen_config_ini_len;

/* Payload Manager, the manager UI the default chain ends with. */
extern const uint8_t pldmgr_elf[];
extern const unsigned int pldmgr_elf_len;

/* Delay between consecutive default-chain launches, in milliseconds.
 * Kernel-level payloads need time to finish patching before the next
 * one starts, the same spacing a user's own !5000 autoload lines give. */
#define DEFAULT_CHAIN_DELAY_MS 5000

/* SMP reload watchdog timing, in milliseconds. The watchdog polls the
 * running big app; when one closes, it waits SMP_RELOAD_DELAY_MS for
 * SMP's own stop handling (kstuff restore, mount cleanup), re-sends the
 * embedded SMP ELF — a fresh instance SIGTERMs the old one away and
 * takes over with clean state — then waits SMP_RELOAD_SETTLE_MS for the
 * new instance's startup scan before watching for the next close. */
#define SMP_RELOAD_POLL_MS   3000
#define SMP_RELOAD_DELAY_MS  8000
#define SMP_RELOAD_SETTLE_MS 5000

/* Launch the default chain and then Payload Manager.
 * Returns 0 if every payload was handed to elfldr, -1 otherwise. */
int run_default_chain(void);

/* Keep the session's ShadowMountPlus healthy: re-send the embedded SMP
 * ELF after every game/app close so its per-title runtime state (the
 * stale mounted/prepared book of upstream issue #153) can never wedge
 * the scanner. Runs forever — the autoloader process stays alive as a
 * small daemon for the rest of the session. Only the default chain
 * uses it; autoload.txt chains keep full control of their payloads. */
void run_smp_reload_watchdog(void);

#endif /* DEFAULT_CHAIN_H */
