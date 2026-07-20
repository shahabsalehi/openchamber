import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SETTINGS_CONTROL_CLUSTER_CLASS, SettingsFieldRow, SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { WebV2API, WebV2CredentialMetadata } from '@/lib/api/types';
import { createCredentialRequestScope, deleteCredentialValue, emptyCredentialSecretValues, hasWebV2CredentialCapability, loadCredentialMetadata, revokeCredentialValue, requiresCredentialConfirmation, rotateCredentialValue } from './webV2CredentialState';

type PendingMutation =
  | { type: 'create' }
  | { type: 'rotate'; credentialId: string }
  | { type: 'revoke'; credentialId: string }
  | { type: 'delete'; credentialId: string }
  | null;

type Confirmation = { credential: WebV2CredentialMetadata; type: 'revoke' | 'delete' } | null;
type CredentialRequest = ReturnType<ReturnType<typeof createCredentialRequestScope>['start']>;
type CredentialRefresh = ReturnType<ReturnType<typeof createCredentialRequestScope>['startRefresh']>;

const formatDate = (timestamp: number) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(timestamp));

interface WebV2CredentialSettingsProps {
  webV2?: WebV2API;
}

export const WebV2CredentialSettings: React.FC<WebV2CredentialSettingsProps> = ({ webV2 }) => {
  const { t } = useI18n();
  const [credentials, setCredentials] = React.useState<WebV2CredentialMetadata[] | null>(null);
  const credentialsRef = React.useRef<WebV2CredentialMetadata[] | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [errorKey, setErrorKey] = React.useState<'load' | 'mutation' | null>(null);
  const [name, setName] = React.useState('');
  const [createValue, setCreateValue] = React.useState('');
  const [rotationValues, setRotationValues] = React.useState<Record<string, string>>({});
  const [pendingMutation, setPendingMutation] = React.useState<PendingMutation>(null);
  const [confirmation, setConfirmation] = React.useState<Confirmation>(null);
  const secretValuesRef = React.useRef(emptyCredentialSecretValues());
  const requestScopeRef = React.useRef(createCredentialRequestScope());
  const webV2Ref = React.useRef(webV2);
  webV2Ref.current = webV2;

  const clearSecrets = React.useCallback(() => {
    secretValuesRef.current = emptyCredentialSecretValues();
    setCreateValue('');
    setRotationValues({});
  }, []);

  const setCreateSecret = React.useCallback((value: string) => {
    secretValuesRef.current.createValue = value;
    setCreateValue(value);
  }, []);

  const setRotationSecret = React.useCallback((credentialId: string, value: string) => {
    secretValuesRef.current.rotationValues[credentialId] = value;
    setRotationValues((current) => ({ ...current, [credentialId]: value }));
  }, []);

  const clearRotationSecret = React.useCallback((credentialId: string) => {
    delete secretValuesRef.current.rotationValues[credentialId];
    setRotationValues((current) => {
      const remaining = { ...current };
      delete remaining[credentialId];
      return remaining;
    });
  }, []);

  const isCurrentRequest = React.useCallback((api: WebV2API, request: CredentialRequest) =>
    webV2Ref.current === api
    && hasWebV2CredentialCapability(webV2Ref.current)
    && requestScopeRef.current.isCurrent(request), []);

  const isCurrentRefresh = React.useCallback((api: WebV2API, refresh: CredentialRefresh) =>
    webV2Ref.current === api
    && hasWebV2CredentialCapability(webV2Ref.current)
    && requestScopeRef.current.isCurrentRefresh(refresh), []);

  const refreshCredentials = React.useCallback(async (api: WebV2API) => {
    if (webV2Ref.current !== api || !hasWebV2CredentialCapability(webV2Ref.current)) return false;
    const refresh = requestScopeRef.current.startRefresh();
    if (!isCurrentRefresh(api, refresh)) {
      requestScopeRef.current.finish(refresh.request);
      return false;
    }
    setIsLoading(true);
    setErrorKey(null);
    try {
      const result = await loadCredentialMetadata(api, credentialsRef.current, { signal: refresh.request.controller.signal });
      if (!isCurrentRefresh(api, refresh)) return false;
      if (result.failed) {
        setErrorKey('load');
        setIsLoading(false);
        return false;
      }
      credentialsRef.current = result.credentials;
      setCredentials(result.credentials);
      setIsLoading(false);
      return true;
    } finally {
      requestScopeRef.current.finish(refresh.request);
    }
  }, [isCurrentRefresh]);

  React.useEffect(() => {
    const requestScope = requestScopeRef.current;
    if (!hasWebV2CredentialCapability(webV2)) {
      requestScope.invalidate();
      clearSecrets();
      credentialsRef.current = null;
      setCredentials(null);
      setErrorKey(null);
      setIsLoading(false);
      setPendingMutation(null);
      setConfirmation(null);
      return;
    }

    void refreshCredentials(webV2);
    return () => {
      requestScope.invalidate();
      clearSecrets();
    };
  }, [clearSecrets, refreshCredentials, webV2]);

  if (!hasWebV2CredentialCapability(webV2)) return null;

  const createCredential = async () => {
    const trimmedName = name.trim();
    const value = secretValuesRef.current.createValue;
    if (!trimmedName || !value) return;

    requestScopeRef.current.invalidateRefreshes();
    const request = requestScopeRef.current.start();
    if (!isCurrentRequest(webV2, request)) {
      requestScopeRef.current.finish(request);
      return;
    }
    setPendingMutation({ type: 'create' });
    setErrorKey(null);
    try {
      await webV2.createCredential({ name: trimmedName, provider: 'openai', value }, { signal: request.controller.signal });
      if (!isCurrentRequest(webV2, request)) return;
      setName('');
      setCreateSecret('');
      await refreshCredentials(webV2);
    } catch {
      if (isCurrentRequest(webV2, request)) setErrorKey('mutation');
    } finally {
      if (isCurrentRequest(webV2, request)) setPendingMutation(null);
      requestScopeRef.current.finish(request);
    }
  };

  const rotateCredential = async (credential: WebV2CredentialMetadata) => {
    const value = secretValuesRef.current.rotationValues[credential.credentialId] ?? '';
    if (!value) return;

    requestScopeRef.current.invalidateRefreshes();
    const request = requestScopeRef.current.start();
    if (!isCurrentRequest(webV2, request)) {
      requestScopeRef.current.finish(request);
      return;
    }
    setPendingMutation({ type: 'rotate', credentialId: credential.credentialId });
    setErrorKey(null);
    try {
      await rotateCredentialValue(webV2, credential, value, { signal: request.controller.signal });
      if (!isCurrentRequest(webV2, request)) return;
      clearRotationSecret(credential.credentialId);
      await refreshCredentials(webV2);
    } catch {
      if (isCurrentRequest(webV2, request)) setErrorKey('mutation');
    } finally {
      if (isCurrentRequest(webV2, request)) setPendingMutation(null);
      requestScopeRef.current.finish(request);
    }
  };

  const confirmMutation = async () => {
    if (!confirmation) return;
    const { credential, type } = confirmation;
    requestScopeRef.current.invalidateRefreshes();
    const request = requestScopeRef.current.start();
    if (!isCurrentRequest(webV2, request)) {
      requestScopeRef.current.finish(request);
      return;
    }
    setPendingMutation({ type, credentialId: credential.credentialId });
    setErrorKey(null);
    try {
      if (type === 'revoke') {
        await revokeCredentialValue(webV2, credential, { signal: request.controller.signal });
      } else {
        await deleteCredentialValue(webV2, credential, { signal: request.controller.signal });
      }
      if (!isCurrentRequest(webV2, request)) return;
      setConfirmation(null);
      await refreshCredentials(webV2);
    } catch {
      if (isCurrentRequest(webV2, request)) setErrorKey('mutation');
    } finally {
      if (isCurrentRequest(webV2, request)) setPendingMutation(null);
      requestScopeRef.current.finish(request);
    }
  };

  const controlsDisabled = pendingMutation !== null;
  const confirmationName = confirmation?.credential.name ?? '';
  const confirmationType = confirmation?.type;

  return (
    <SettingsSection title={t('settings.providers.webV2Credentials.title')} info={t('settings.providers.webV2Credentials.info')} settingsItem="providers.web-v2-credentials" contentClassName="space-y-5">
      {errorKey ? <p role="alert" className="typography-meta text-[var(--status-error)]">{t(errorKey === 'load' ? 'settings.providers.webV2Credentials.error.load' : 'settings.providers.webV2Credentials.error.mutation')}</p> : null}

      <div className="space-y-3">
        <SettingsFieldRow label={t('settings.providers.webV2Credentials.create.nameLabel')} alignEnd={false}>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('settings.providers.webV2Credentials.create.namePlaceholder')} aria-label={t('settings.providers.webV2Credentials.create.nameAria')} className={SETTINGS_CONTROL_CLUSTER_CLASS} disabled={controlsDisabled} />
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.providers.webV2Credentials.create.valueLabel')} alignEnd={false}>
          <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex min-w-0 gap-2`}>
            <Input type="password" autoComplete="new-password" value={createValue} onChange={(event) => setCreateSecret(event.target.value)} placeholder={t('settings.providers.webV2Credentials.create.valuePlaceholder')} aria-label={t('settings.providers.webV2Credentials.create.valueAria')} className="min-w-0 flex-1" disabled={controlsDisabled} />
            <Button size="sm" onClick={() => void createCredential()} disabled={!name.trim() || !createValue || controlsDisabled}>
              {pendingMutation?.type === 'create' ? t('settings.providers.webV2Credentials.actions.creating') : t('settings.providers.webV2Credentials.actions.create')}
            </Button>
          </div>
        </SettingsFieldRow>
      </div>

      <div className="space-y-3 border-t border-border/60 pt-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="typography-settings-group-title text-foreground">{t('settings.providers.webV2Credentials.list.title')}</h3>
          <Button variant="outline" size="xs" onClick={() => void refreshCredentials(webV2)} disabled={isLoading || controlsDisabled}>{t('settings.providers.webV2Credentials.actions.refresh')}</Button>
        </div>
        {isLoading && credentials === null ? <p className="typography-meta text-muted-foreground">{t('settings.providers.webV2Credentials.state.loading')}</p> : null}
        {credentials?.length === 0 ? <p className="typography-meta text-muted-foreground">{t('settings.providers.webV2Credentials.state.empty')}</p> : null}
        <div className="space-y-5">
          {credentials?.map((credential) => {
            const isCredentialPending = pendingMutation !== null
              && pendingMutation.type !== 'create'
              && pendingMutation.credentialId === credential.credentialId;
            return (
              <div key={credential.credentialId} className="space-y-3 border-b border-border/60 pb-5 last:border-b-0 last:pb-0">
                <div className="flex flex-col justify-between gap-2 @xl:flex-row @xl:items-start">
                  <div className="min-w-0">
                    <p className="typography-settings-field-label text-foreground">{credential.name}</p>
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.webV2Credentials.metadata.provider', { provider: credential.provider })}{' · '}{t('settings.providers.webV2Credentials.metadata.generation', { generation: String(credential.generation) })}{' · '}{credential.status === 'active' ? t('settings.providers.webV2Credentials.status.active') : t('settings.providers.webV2Credentials.status.revoked')}</p>
                    <p className="typography-micro text-muted-foreground">{t('settings.providers.webV2Credentials.metadata.created', { timestamp: formatDate(credential.createdAt) })}{' · '}{t('settings.providers.webV2Credentials.metadata.updated', { timestamp: formatDate(credential.updatedAt) })}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="xs" onClick={() => { if (requiresCredentialConfirmation('revoke')) setConfirmation({ credential, type: 'revoke' }); }} disabled={controlsDisabled || credential.status === 'revoked'}>{t('settings.providers.webV2Credentials.actions.revoke')}</Button>
                    <Button variant="destructive" size="xs" onClick={() => { if (requiresCredentialConfirmation('delete')) setConfirmation({ credential, type: 'delete' }); }} disabled={controlsDisabled}>{t('settings.providers.webV2Credentials.actions.delete')}</Button>
                  </div>
                </div>
                <SettingsStackedField label={t('settings.providers.webV2Credentials.rotate.valueLabel')} controlClassName="max-w-[24rem]">
                  <div className="flex min-w-0 gap-2">
                    <Input type="password" autoComplete="new-password" value={rotationValues[credential.credentialId] ?? ''} onChange={(event) => setRotationSecret(credential.credentialId, event.target.value)} placeholder={t('settings.providers.webV2Credentials.rotate.valuePlaceholder')} aria-label={t('settings.providers.webV2Credentials.rotate.valueAria', { name: credential.name })} className="min-w-0 flex-1" disabled={controlsDisabled} />
                    <Button size="sm" onClick={() => void rotateCredential(credential)} disabled={!rotationValues[credential.credentialId] || controlsDisabled}>{isCredentialPending && pendingMutation?.type === 'rotate' ? t('settings.providers.webV2Credentials.actions.rotating') : t('settings.providers.webV2Credentials.actions.rotate')}</Button>
                  </div>
                </SettingsStackedField>
              </div>
            );
          })}
        </div>
      </div>

      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !pendingMutation) setConfirmation(null); }}>
        <DialogContent showCloseButton={!pendingMutation}>
          <DialogHeader>
            <DialogTitle>{confirmationType === 'revoke' ? t('settings.providers.webV2Credentials.confirm.revokeTitle') : t('settings.providers.webV2Credentials.confirm.deleteTitle')}</DialogTitle>
            <DialogDescription>{confirmationType === 'revoke' ? t('settings.providers.webV2Credentials.confirm.revokeDescription', { name: confirmationName }) : t('settings.providers.webV2Credentials.confirm.deleteDescription', { name: confirmationName })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)} disabled={pendingMutation !== null}>{t('settings.providers.webV2Credentials.actions.cancel')}</Button>
            <Button variant={confirmationType === 'delete' ? 'destructive' : 'default'} onClick={() => void confirmMutation()} disabled={pendingMutation !== null}>{pendingMutation?.type === 'revoke' ? t('settings.providers.webV2Credentials.actions.revoking') : pendingMutation?.type === 'delete' ? t('settings.providers.webV2Credentials.actions.deleting') : confirmationType === 'revoke' ? t('settings.providers.webV2Credentials.actions.revoke') : t('settings.providers.webV2Credentials.actions.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};
