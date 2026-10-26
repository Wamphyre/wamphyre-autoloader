/*
 * default_chain.c — the built-in payload chain for unconfigured consoles
 *
 * Runs when no autoload.txt exists: ensure etaHEN has a config (built-in
 * FTP on port 1337, FPS meter off — an existing config is never touched),
 * launch kstuff-lite, ShadowMountPlus and etaHEN with a fixed delay
 * between them, then start Payload Manager as the manager UI.
 */

#include "default_chain.h"
#include "autoloader.h"
#include "launcher.h"
#include "notification.h"

#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

/* -----------------------------------------------------------------------
 * ensure_etahen_config
 *
 * etaHEN reads /data/etaHEN/config.ini at startup. A console that has
 * never run etaHEN has none, so the embedded template is installed there
 * before etaHEN is launched. A config that already exists is left alone:
 * the owner of the console may have tuned it on purpose.
 * ----------------------------------------------------------------------- */
static int ensure_etahen_config(void) {
    const char *dir = "/data/etaHEN";
    const char *cfg = "/data/etaHEN/config.ini";
    struct stat st;

    mkdir(dir, 0777); /* EEXIST is fine: etaHEN owns this directory too */

    if (stat(cfg, &st) == 0) {
        printf("[autoloader] etaHEN config already present, not touching it\n");
        fflush(stdout);
        return 0;
    }

    FILE *f = fopen(cfg, "w");
    if (!f) {
        printf("[autoloader] could not create %s\n", cfg);
        fflush(stdout);
        return -1;
    }

    size_t written = fwrite(etahen_config_ini, 1, etahen_config_ini_len, f);
    fclose(f);
    chmod(cfg, 0666);

    if (written != etahen_config_ini_len) {
        printf("[autoloader] short write creating %s\n", cfg);
        fflush(stdout);
        return -1;
    }

    printf("[autoloader] installed etaHEN config (FTP port 1337, FPS meter off)\n");
    fflush(stdout);
    return 0;
}

/* -----------------------------------------------------------------------
 * run_default_chain
 * ----------------------------------------------------------------------- */
int run_default_chain(void) {
    struct chain_entry {
        const char *name;
        const uint8_t *data;
        unsigned int len;
    };
    /* Automatic storage: the array is initialised from the extern symbols,
     * which C only allows for run-time (non-static) initialisers. */
    const struct chain_entry chain[] = {
        { "kstuff-lite", kstuff_elf, kstuff_elf_len },
        { "ShadowMountPlus", smp_elf, smp_elf_len },
        { "etaHEN", etahen_elf, etahen_elf_len },
    };

    printf("[autoloader] No autoload config found. Running the default chain.\n");
    fflush(stdout);

    /* etaHEN reads its config at startup, so the template must be in place
     * before the chain launches it. */
    if (ensure_etahen_config() != 0) {
        autoloader_notify("Warning: could not install the etaHEN config");
    }

    int errors = 0;
    for (size_t i = 0; i < sizeof(chain) / sizeof(chain[0]); i++) {
        autoloader_notify("Launching: %s", chain[i].name);
        if (launch_elf_from_memory(chain[i].data, chain[i].len) != 0) {
            autoloader_notify("Failed to launch: %s", chain[i].name);
            errors++;
        }

        /* Give the payload time to settle before the next one starts —
         * the same spacing a user's own !5000 autoload lines provide. */
        usleep(DEFAULT_CHAIN_DELAY_MS * 1000);
    }

    /* The chain ends where the old fallback began: Payload Manager stays
     * available as the manager UI for everything the chain does not own. */
    printf("[autoloader] Starting Payload Manager...\n");
    fflush(stdout);
    if (launch_elf_from_memory(pldmgr_elf, pldmgr_elf_len) != 0) {
        autoloader_notify("ERROR: failed to launch Payload Manager");
        printf("[autoloader] ERROR: failed to launch pldmgr\n");
        fflush(stdout);
        errors++;
    }

    autoloader_notify("Default chain complete (%d error(s))", errors);
    return errors ? -1 : 0;
}
