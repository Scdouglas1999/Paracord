/* Test tooling for the nested KWin only: list the NVIDIA DRM device first so
 * KWin's virtual backend renders on the RTX 4080 (the owner's compositor GPU),
 * not on the AMD iGPU that libdrm enumerates first. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <xf86drm.h>
int drmGetDevices2(uint32_t flags, drmDevicePtr devices[], int max_devices) {
    static int (*real)(uint32_t, drmDevicePtr[], int);
    if (!real) real = dlsym(RTLD_NEXT, "drmGetDevices2");
    int n = real(flags, devices, max_devices);
    if (n <= 1 || !devices) return n;
    for (int i = 1; i < n && i < max_devices; i++) {
        if (devices[i]->bustype == DRM_BUS_PCI && devices[i]->deviceinfo.pci->vendor_id == 0x10de) {
            drmDevicePtr t = devices[0]; devices[0] = devices[i]; devices[i] = t; break;
        }
    }
    return n;
}
