import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { economyApi, type LevelRoleMapping } from '../../api/economy';
import { extractApiError } from '../../api/client';
import type { Role } from '../../types';
import { Button } from '../ui/Button';
import { LoadingSpinner } from '../ui/Feedback';
import { toast } from '../../stores/toastStore';

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
        <LoadingSpinner />
      </div>
    );
  }

  const roleNameById = new Map(roles.map((r) => [r.id, r.name]));

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-text-primary">Economy &amp; XP</h2>
        <p className="mt-1 text-sm text-text-muted">
          Configure level-up role rewards for this server. XP rates and cooldowns are controlled via
          server environment variables (<code className="text-xs">PARACORD_XP_COOLDOWN_SECONDS</code>).
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-accent-danger/35 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger">
          {error}
        </div>
      )}

      {/* Level-role mappings */}
      <div className="settings-surface-card space-y-4">
        <div>
          <h3 className="font-semibold text-text-primary">Level-Up Role Rewards</h3>
          <p className="mt-0.5 text-xs text-text-muted">
            Assign a role that members automatically receive when they reach a given level.
          </p>
        </div>

        {mappings.length === 0 ? (
          <p className="text-sm text-text-secondary">No level-role mappings configured yet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle/60 rounded-lg border border-border-subtle">
            {mappings.map((m) => {
              const roleName = roleNameById.get(m.role_id) ?? m.role_id;
              return (
                <li
                  key={`${m.level}-${m.role_id}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm"
                >
                  <span className="font-medium text-text-primary">Level {m.level}</span>
                  <span className="flex-1 text-text-secondary">{roleName}</span>
                  <button
                    type="button"
                    onClick={() => removeMapping(m.level, m.role_id)}
                    className="text-text-muted transition-colors hover:text-accent-danger"
                    aria-label={`Remove level ${m.level} mapping for ${roleName}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add new mapping */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-text-secondary">Level</label>
            <input
              aria-label="Level"
              type="number"
              min={1}
              step={1}
              placeholder="e.g. 5"
              value={newMappingLevel}
              onChange={(e) => setNewMappingLevel(e.target.value)}
              className="input-field w-24"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-text-secondary">Role</label>
            <select
              aria-label="Role"
              value={newMappingRoleId}
              onChange={(e) => setNewMappingRoleId(e.target.value)}
              className="select-field w-48"
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
            </select>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={addMapping}
            disabled={!newMappingLevel || !newMappingRoleId || assignableRoles.length === 0}
          >
            <Plus size={14} className="mr-1" />
            Add
          </Button>
        </div>
      </div>

      {/* XP system info */}
      <div className="settings-surface-card space-y-3">
        <h3 className="font-semibold text-text-primary">XP System Info</h3>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">XP per message</dt>
            <dd className="font-medium text-text-primary">15-25 XP (scales with message length)</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">Cooldown</dt>
            <dd className="font-medium text-text-primary">
              Configurable via <code className="text-xs">PARACORD_XP_COOLDOWN_SECONDS</code> (default: 45s)
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-muted">Level formula</dt>
            <dd className="font-medium text-text-primary">level = floor(sqrt(total_xp / 100))</dd>
          </div>
        </dl>
      </div>

      <div className="flex justify-end">
        <Button onClick={() => void onSave()} loading={saving} disabled={saving}>
          Save Changes
        </Button>
      </div>
    </div>
  );
}
