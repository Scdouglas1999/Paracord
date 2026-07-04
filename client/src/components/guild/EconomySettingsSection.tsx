import { useEffect, useState } from 'react';
import { Plus, Trash2, TrendingUp } from 'lucide-react';
import { economyApi, type LevelRoleMapping } from '../../api/economy';
import { extractApiError } from '../../api/client';
import type { Role } from '../../types';
import { Button } from '../ui/Button';
import { Input, Select } from '../ui/Input';
import { EmptyState, LoadingSpinner } from '../ui/Feedback';
import { toast } from '../../stores/toastStore';
import { SectionHeader, FieldLabel, GroupLabel } from './SettingsPrimitives';

interface EconomySettingsSectionProps {
  guildId: string;
  roles: Role[];
}

export function EconomySettingsSection({ guildId, roles }: EconomySettingsSectionProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Level-role mappings state
  const [mappings, setMappings] = useState<LevelRoleMapping[]>([]);
  const [newMappingLevel, setNewMappingLevel] = useState('');
  const [newMappingRoleId, setNewMappingRoleId] = useState('');

  const assignableRoles = roles.filter((r) => r.id !== guildId);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    economyApi
      .getLevelRoles(guildId)
      .then(({ data }) => {
        if (cancelled) return;
        setMappings(data.mappings || []);
        if (assignableRoles.length > 0 && !newMappingRoleId) {
          setNewMappingRoleId(assignableRoles[0].id);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(extractApiError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildId]);

  // Set default role when roles load
  useEffect(() => {
    if (assignableRoles.length > 0 && !newMappingRoleId) {
      setNewMappingRoleId(assignableRoles[0].id);
    }
  }, [assignableRoles, newMappingRoleId]);

  const addMapping = () => {
    const level = parseInt(newMappingLevel, 10);
    if (!newMappingLevel || isNaN(level) || level < 1) return;
    if (!newMappingRoleId) return;
    // Replace if same level already exists
    setMappings((prev) => {
      const filtered = prev.filter((m) => !(m.level === level && m.role_id === newMappingRoleId));
      return [...filtered, { level, role_id: newMappingRoleId }].sort((a, b) => a.level - b.level);
    });
    setNewMappingLevel('');
  };

  const removeMapping = (level: number, roleId: string) => {
    setMappings((prev) => prev.filter((m) => !(m.level === level && m.role_id === roleId)));
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await economyApi.updateLevelRoles(guildId, mappings);
      toast.success('Economy settings saved.');
    } catch (err: unknown) {
      setError(extractApiError(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner label="Loading economy settings…" />
      </div>
    );
  }

  const roleNameById = new Map(roles.map((r) => [r.id, r.name]));
  const roleColorHex = (roleId: string) => {
    const role = roles.find((r) => r.id === roleId);
    if (!role?.color) return 'var(--text-muted)';
    return `#${role.color.toString(16).padStart(6, '0')}`;
  };

  return (
    <div className="flex flex-col gap-8">
      <SectionHeader
        title="Economy & XP"
        description={
          <>
            Reward activity with level-up roles. XP rates and cooldowns are tuned server-side via the
            {' '}
            <code className="font-code text-[12px] text-text-secondary">PARACORD_XP_COOLDOWN_SECONDS</code>
            {' '}
            environment variable.
          </>
        }
        action={
          <Button onClick={() => void onSave()} loading={saving} disabled={saving}>
            Save changes
          </Button>
        }
      />

      {error && (
        <div className="rounded-md border border-accent-danger/35 bg-danger-tint px-4 py-3 text-label text-accent-danger">
          {error}
        </div>
      )}

      {/* Level-role rewards */}
      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>Level-up role rewards</GroupLabel>
        <p className="mt-2 text-[13.5px] leading-relaxed text-text-secondary">
          Members automatically earn the mapped role the moment they cross the given level.
        </p>

        {mappings.length === 0 ? (
          <EmptyState
            className="!py-6"
            icon={<TrendingUp size={20} />}
            title="No level rewards yet"
            description="Pair a level with a role below and members will unlock it as they climb."
          />
        ) : (
          <ul className="mt-4 divide-y divide-border-subtle">
            {mappings.map((m) => {
              const roleName = roleNameById.get(m.role_id) ?? m.role_id;
              return (
                <li
                  key={`${m.level}-${m.role_id}`}
                  className="group flex items-center gap-3 py-2.5"
                >
                  <span className="min-w-[4.5rem] font-code text-meta tabular-nums text-text-muted">
                    LVL {m.level}
                  </span>
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: roleColorHex(m.role_id) }}
                    aria-hidden
                  />
                  <span className="flex-1 truncate text-label text-text-primary">{roleName}</span>
                  <button
                    type="button"
                    onClick={() => removeMapping(m.level, m.role_id)}
                    className="icon-btn opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Remove level ${m.level} reward for ${roleName}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add new mapping */}
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="flex flex-col">
            <FieldLabel>Level</FieldLabel>
            <Input
              aria-label="Level"
              type="number"
              min={1}
              step={1}
              placeholder="5"
              value={newMappingLevel}
              onChange={(e) => setNewMappingLevel(e.target.value)}
              className="w-24 font-code tabular-nums"
            />
          </label>
          <label className="flex flex-col">
            <FieldLabel>Role</FieldLabel>
            <Select
              aria-label="Role"
              value={newMappingRoleId}
              onChange={(e) => setNewMappingRoleId(e.target.value)}
              className="w-52"
              disabled={assignableRoles.length === 0}
            >
              {assignableRoles.length === 0 ? (
                <option value="">No roles available</option>
              ) : (
                assignableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))
              )}
            </Select>
          </label>
          <Button
            variant="outline"
            onClick={addMapping}
            disabled={!newMappingLevel || !newMappingRoleId || assignableRoles.length === 0}
          >
            <Plus size={15} className="mr-1.5" />
            Add reward
          </Button>
        </div>
      </section>

      {/* XP system info */}
      <section className="border-t border-border-subtle pt-6">
        <GroupLabel>How XP works</GroupLabel>
        <dl className="mt-4 divide-y divide-border-subtle text-label">
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-text-secondary">XP per message</dt>
            <dd className="text-right text-text-primary">
              <span className="font-code tabular-nums">15–25</span> XP, scaled by length
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-text-secondary">Cooldown</dt>
            <dd className="text-right text-text-primary">
              <span className="font-code tabular-nums">45s</span> default, env-configurable
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-text-secondary">Level formula</dt>
            <dd className="text-right font-code text-[12.5px] tabular-nums text-text-primary">
              floor(sqrt(total_xp / 100))
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
