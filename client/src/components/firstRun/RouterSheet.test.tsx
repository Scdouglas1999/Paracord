import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RouterSheet } from './Sheets';

afterEach(cleanup);

function renderSheet(gatewayIp: string | null) {
  render(
    <RouterSheet
      open
      onClose={() => {}}
      variant="refused"
      gatewayIp={gatewayIp}
      lanIp="192.168.50.20"
      port={8090}
    />,
  );
}

describe('"Let friends in" sheet', () => {
  it('names the router that answered', () => {
    renderSheet('192.168.50.1');
    const sheet = screen.getByTestId('fr-router-sheet');
    expect(sheet.textContent).toContain('192.168.50.1');
    expect(sheet.textContent).not.toContain('usually');
  });

  it('keeps the generic line only when no router answered', () => {
    renderSheet(null);
    expect(screen.getByTestId('fr-router-sheet').textContent).toContain('usually');
  });
});
