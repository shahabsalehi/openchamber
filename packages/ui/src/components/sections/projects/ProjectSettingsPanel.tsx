import React from 'react';
import { WorktreeSectionContent } from '@/components/sections/openchamber/WorktreeSectionContent';
import { ProjectActionsSection } from '@/components/sections/projects/ProjectActionsSection';
import { ProjectIdentityEditor } from '@/components/sections/projects/ProjectIdentityEditor';
import {
  useProjectIdentityForm,
  type ProjectIdentitySaveData,
} from '@/components/sections/projects/useProjectIdentityForm';
import type { ProjectEntry } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

type ProjectSettingsPanelProps = {
  project: ProjectEntry | null;
  onIdentitySave: (data: ProjectIdentitySaveData) => void | Promise<void>;
  identityEditorClassName?: string;
};

export const ProjectSettingsPanel: React.FC<ProjectSettingsPanelProps> = ({
  project,
  onIdentitySave,
  identityEditorClassName,
}) => {
  const { t } = useI18n();
  const form = useProjectIdentityForm(project);

  const projectRef = React.useMemo(() => {
    if (!project) {
      return null;
    }
    return { id: project.id, path: project.path };
  }, [project]);

  const handleIdentitySave = React.useCallback(async () => {
    const data = await form.prepareSaveData();
    if (!data) {
      return;
    }
    await onIdentitySave(data);
  }, [form, onIdentitySave]);

  if (!project || !projectRef) {
    return null;
  }

  return (
    <>
      <ProjectIdentityEditor
        form={form}
        onSave={handleIdentitySave}
        className={identityEditorClassName}
      />

      <div data-settings-item="projects.actions" className="mb-8">
        <section className="px-2 pb-2 pt-0">
          <ProjectActionsSection projectRef={projectRef} />
        </section>
      </div>

      <div data-settings-item="projects.worktree" className="mb-8">
        <div className="mb-1 px-1">
          <h3 className="typography-ui-header font-medium text-foreground">
            {t('settings.projects.page.section.worktree')}
          </h3>
        </div>
        <section className="px-2 pb-2 pt-0">
          <WorktreeSectionContent projectRef={projectRef} />
        </section>
      </div>
    </>
  );
};
