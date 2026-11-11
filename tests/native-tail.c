// Authored test harness. Never calls guest code or changes executable mappings.
#include <dlfcn.h>
#include <inttypes.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    void *handle = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!handle) { fprintf(stderr, "%s\n", dlerror()); return 3; }
    const struct mach_header_64 *header = NULL;
    intptr_t slide = 0;
    char *wanted = realpath(argv[1], NULL);
    if (!wanted) return 4;
    for (uint32_t i = 0; i < _dyld_image_count(); i++) {
        const char *name = _dyld_get_image_name(i);
        char *actual = name ? realpath(name, NULL) : NULL;
        if (actual && !strcmp(actual, wanted)) {
            header = (const struct mach_header_64 *)_dyld_get_image_header(i);
            slide = _dyld_get_image_vmaddr_slide(i);
        }
        free(actual);
    }
    free(wanted);
    if (!header) return 5;
    const uint8_t *command = (const uint8_t *)(header + 1);
    uint64_t start = 0, length = 0, linkedit = 0;
    for (uint32_t i = 0; i < header->ncmds; i++) {
        const struct load_command *lc = (const void *)command;
        if (lc->cmd == LC_SEGMENT_64) {
            const struct segment_command_64 *segment = (const void *)command;
            if (!strncmp(segment->segname, "__NX_HEAP", 16)) {
                start = segment->vmaddr + slide;
                length = segment->vmsize;
            }
            if (!strncmp(segment->segname, "__LINKEDIT", 16)) linkedit = segment->vmaddr + slide;
        }
        command += lc->cmdsize;
    }
    if (!start || !length || length > UINT64_MAX - start || start + length != linkedit) return 6;
    uint64_t cursor = start, end = start + length;
    while (cursor < end) {
        mach_vm_address_t address = cursor;
        mach_vm_size_t size = 0;
        natural_t depth = 0;
        vm_region_submap_info_data_64_t info;
        for (;;) {
            mach_msg_type_number_t count = VM_REGION_SUBMAP_INFO_COUNT_64;
            kern_return_t kr = mach_vm_region_recurse(mach_task_self(), &address, &size,
                &depth, (vm_region_recurse_info_t)&info, &count);
            if (kr || !size || address > cursor || size > UINT64_MAX - address || address + size <= cursor) return 7;
            if (!info.is_submap) break;
            if (++depth > 8) return 8;
        }
        if (info.protection != (VM_PROT_READ | VM_PROT_WRITE) || info.external_pager) {
            fprintf(stderr, "Tail is not anonymous RW at 0x%" PRIx64 "\n", cursor);
            return 9;
        }
        cursor = address + size;
    }
    // This mapping hint must not replace dyld's reservation. It reproduces the
    // old allocator's assumption without using MAP_FIXED or leaving an allocation.
    void *other = mmap((void *)(uintptr_t)start, 0x4000, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANON, -1, 0);
    if (other != MAP_FAILED) {
        if (other == (void *)(uintptr_t)start) return 10;
        if (munmap(other, 0x4000)) return 11;
    }
    volatile uint8_t *first = (void *)(uintptr_t)start;
    volatile uint8_t *last = (void *)(uintptr_t)(end - 1);
    if (*first || *last) return 12;
    *first = 0x12; *last = 0x34;
    if (*first != 0x12 || *last != 0x34) return 13;
    printf("PASS: anonymous RW dyld tail 0x%" PRIx64 " + 0x%" PRIx64 ", boundary writes verified\n", start, length);
    // Keep dyld and its reservation alive until process exit, as the runtime does.
    return 0;
}
