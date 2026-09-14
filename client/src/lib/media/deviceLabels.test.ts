import { describe, expect, it } from 'vitest';
import {
  buildDevicePickerOptions,
  friendlyDeviceLabel,
  isAdvancedMediaDevice,
  isBrowserPseudoDeviceId,
  systemDefaultOptionLabel,
  type RawMediaDevice,
} from './deviceLabels';

describe('friendlyDeviceLabel', () => {
  it('humanizes ALSA/Pulse-style technical ids', () => {
    expect(
      friendlyDeviceLabel(
        'alsa_output.usb-Focusrite_Scarlett_Solo_USB-00.analog-stereo',
        'audiooutput'
      )
    ).toBe('Focusrite Scarlett Solo USB');
    expect(
      friendlyDeviceLabel('alsa_input.pci-0000_00_1f.3.analog-stereo', 'audioinput')
    ).toBe('Built-in Audio');
    expect(
      friendlyDeviceLabel('alsa_output.pci-0000_01_00.1.hdmi-stereo', 'audiooutput')
    ).toBe('HDMI Audio');
  });

  it('strips redundant channel-layout suffixes from friendly names', () => {
    expect(friendlyDeviceLabel('Scarlett Solo USB Analog Stereo', 'audiooutput')).toBe(
      'Scarlett Solo USB'
    );
    expect(friendlyDeviceLabel('Built-in Audio Analog Surround 5.1', 'audiooutput')).toBe(
      'Built-in Audio'
    );
  });

  it('maps empty / default labels to a system-default phrase', () => {
    expect(friendlyDeviceLabel('default', 'audioinput')).toBe('System default microphone');
    expect(friendlyDeviceLabel('', 'audiooutput', 'abc123')).toBe('System default speaker');
  });

  it('drops the Monitor of prefix while leaving the rest readable', () => {
    expect(friendlyDeviceLabel('Monitor of Scarlett Solo USB', 'audioinput')).toBe(
      'Scarlett Solo USB (monitor)'
    );
  });
});

describe('isAdvancedMediaDevice', () => {
  it('flags monitors, null sinks, and common virtual processors', () => {
    expect(
      isAdvancedMediaDevice({
        deviceId: '1',
        label: 'Monitor of Speakers',
        kind: 'audioinput',
      })
    ).toBe(true);
    expect(
      isAdvancedMediaDevice({
        deviceId: 'auto_null',
        label: 'Dummy Output',
        kind: 'audiooutput',
      })
    ).toBe(true);
    expect(
      isAdvancedMediaDevice({
        deviceId: '2',
        label: 'Easy Effects Sink',
        kind: 'audiooutput',
      })
    ).toBe(true);
  });

  it('does not flag ordinary hardware', () => {
    expect(
      isAdvancedMediaDevice({
        deviceId: '3',
        label: 'Scarlett Solo USB',
        kind: 'audioinput',
      })
    ).toBe(false);
  });
});

describe('buildDevicePickerOptions', () => {
  const devices: RawMediaDevice[] = [
    {
      deviceId: 'default',
      label: 'Default',
      kind: 'audiooutput',
      isDefault: true,
    },
    {
      deviceId: '0',
      label: 'Scarlett Solo USB Analog Stereo',
      kind: 'audiooutput',
      isDefault: true,
    },
    {
      deviceId: '1',
      label: 'Scarlett Solo USB Analog Stereo',
      kind: 'audiooutput',
    },
    {
      deviceId: '2',
      label: 'HDA NVidia Digital Stereo (HDMI)',
      kind: 'audiooutput',
    },
    {
      deviceId: '3',
      label: 'Monitor of Scarlett Solo USB',
      kind: 'audiooutput',
    },
    {
      deviceId: '4',
      label: 'Easy Effects Sink',
      kind: 'audiooutput',
    },
    {
      deviceId: '5',
      label: 'Null Output',
      kind: 'audiooutput',
    },
  ];

  it('drops browser pseudo devices and dedupes equivalent labels', () => {
    const options = buildDevicePickerOptions(devices, { showAll: true });
    expect(options.every((o) => !isBrowserPseudoDeviceId(o.deviceId))).toBe(true);
    const scarlett = options.filter((o) => o.label === 'Scarlett Solo USB');
    expect(scarlett).toHaveLength(1);
    expect(scarlett[0]?.deviceId).toBe('0');
    expect(scarlett[0]?.isSystemDefault).toBe(true);
  });

  it('hides advanced devices unless showAll is set', () => {
    const filtered = buildDevicePickerOptions(devices, { showAll: false });
    expect(filtered.map((o) => o.deviceId).sort()).toEqual(['0', '2']);
    expect(filtered.every((o) => !o.isAdvanced)).toBe(true);

    const all = buildDevicePickerOptions(devices, { showAll: true });
    expect(all.some((o) => o.deviceId === '3')).toBe(true);
    expect(all.some((o) => o.deviceId === '4')).toBe(true);
  });

  it('always keeps the currently selected device visible', () => {
    const options = buildDevicePickerOptions(devices, {
      showAll: false,
      selectedDeviceId: '4',
    });
    expect(options.some((o) => o.deviceId === '4')).toBe(true);
  });

  it('prefers the selected duplicate when neither is the OS default', () => {
    const dupes: RawMediaDevice[] = [
      { deviceId: '10', label: 'USB Headset', kind: 'audioinput' },
      { deviceId: '11', label: 'USB Headset', kind: 'audioinput' },
    ];
    const options = buildDevicePickerOptions(dupes, { selectedDeviceId: '11' });
    expect(options).toHaveLength(1);
    expect(options[0]?.deviceId).toBe('11');
  });

  it('sorts the OS default ahead of other devices', () => {
    const options = buildDevicePickerOptions(
      [
        { deviceId: 'a', label: 'Zebra Speakers', kind: 'audiooutput' },
        { deviceId: 'b', label: 'Alpha Speakers', kind: 'audiooutput', isDefault: true },
      ],
      { showAll: true }
    );
    expect(options[0]?.deviceId).toBe('b');
  });

  it('shows a sound-server device name exactly as the sound server said it', () => {
    // These arrive already named by PipeWire. Running the ALSA/browser rescue
    // over them used to eat the part that tells two HDMI outputs apart.
    const options = buildDevicePickerOptions(
      [
        {
          deviceId: 'alsa_output.pci-0000_01_00.1.hdmi-stereo',
          label: 'Odyssey G95SC — Digital Stereo (HDMI)',
          kind: 'audiooutput',
          labelIsFriendly: true,
        },
        {
          deviceId: 'alsa_output.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__sink',
          label: 'Scarlett Solo USB — Direct',
          kind: 'audiooutput',
          labelIsFriendly: true,
        },
      ],
      {}
    );
    expect(options.map((o) => o.label)).toEqual([
      'Odyssey G95SC — Digital Stereo (HDMI)',
      'Scarlett Solo USB — Direct',
    ]);
  });

  it('keeps a monitor of what is playing out of the default microphone list', () => {
    const devices: RawMediaDevice[] = [
      {
        deviceId: 'alsa_input.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__source',
        label: 'Scarlett Solo USB — Direct',
        kind: 'audioinput',
        labelIsFriendly: true,
      },
      {
        deviceId: 'alsa_output.pci-0000_01_00.1.hdmi-stereo.monitor',
        label: 'Monitor of Odyssey G95SC — Digital Stereo (HDMI)',
        kind: 'audioinput',
        labelIsFriendly: true,
      },
    ];
    expect(buildDevicePickerOptions(devices, {}).map((o) => o.deviceId)).toEqual([
      'alsa_input.usb-Focusrite_Scarlett_Solo_USB-00.Direct__Direct__source',
    ]);
    expect(buildDevicePickerOptions(devices, { showAll: true })).toHaveLength(2);
  });
});

describe('systemDefaultOptionLabel', () => {
  it('returns a clear System default label for each kind', () => {
    expect(systemDefaultOptionLabel('audioinput')).toBe('System default');
    expect(systemDefaultOptionLabel('videoinput')).toBe('System default');
  });
});
