export interface NavItem {
  idx: string;
  label: string;
  to: string;
  end?: boolean;
}

/** The seven shell links (SPEC-V2 §9.1). `/mine` is reached from the rail block and the wallet menu. */
export function navItems(): NavItem[] {
  return [
    { idx: '01', label: 'HOME', to: '/', end: true },
    { idx: '02', label: 'OBSERVATORY', to: '/observatory' },
    { idx: '03', label: 'AGENTS', to: '/agents' },
    { idx: '04', label: 'BUY AN AGENT', to: '/buy' },
    { idx: '05', label: 'GRAVEYARD', to: '/graveyard' },
    { idx: '06', label: 'MARKET', to: '/market' },
    { idx: '07', label: 'PROTOCOL', to: '/protocol' },
  ];
}
