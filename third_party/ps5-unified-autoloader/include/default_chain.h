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

/* Byepervisor (source-built from PS5Dev/Byepervisor-Reborn), the optional
 * hypervisor unlock for firmware 13.60. Launched after the rest of the
 * chain so nothing waits on it: it arms, notifies, and then waits in the
 * background for the user to enter Rest Mode and resume. */
extern const uint8_t byepervisor_elf[];
extern const unsigned int byepervisor_elf_len;

/* Delay between consecutive default-chain launches, in milliseconds.
 * Kernel-level payloads need time to finish patching before the next
 * one starts, the same spacing a user's own !5000 autoload lines give. */
#define DEFAULT_CHAIN_DELAY_MS 5000

/* Launch the default chain and then Payload Manager.
 * Returns 0 if every payload was handed to elfldr, -1 otherwise. */
int run_default_chain(void);

#endif /* DEFAULT_CHAIN_H */
