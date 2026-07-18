import { useRef, useState, type ChangeEvent, type FormEvent } from "react";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";
import type {
  AgentAccountUsage,
  AgentRuntimeState,
  CodexUsageSnapshot,
} from "../../../core/models/agent";
import type { XiaoContributionSummary } from "../../../core/models/xiao";
import {
  profileInitials,
  type LocalUserProfile,
} from "../hooks/useLocalProfile";
import "../styles/profile.css";

type ProfilePageProps = {
  accountUsage: AgentAccountUsage | null;
  profile: LocalUserProfile;
  runtime: AgentRuntimeState;
  usage: CodexUsageSnapshot;
  contributions: XiaoContributionSummary;
  onClose: () => void;
  onSaveProfile: (profile: LocalUserProfile) => void;
};

const fullNumber = new Intl.NumberFormat();
const monthLabel = new Intl.DateTimeFormat(undefined, { month: "short" });
const dayLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const avatarSize = 256;

const createAvatar = (file: File) =>
  new Promise<string>((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("Choose an image file."));
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      reject(new Error("Choose an image smaller than 15 MB."));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Xiao could not read that image."));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Xiao could not open that image."));
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = avatarSize;
        canvas.height = avatarSize;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Xiao could not prepare that image."));
          return;
        }
        const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
        const sourceX = (image.naturalWidth - sourceSize) / 2;
        const sourceY = (image.naturalHeight - sourceSize) / 2;
        context.drawImage(
          image,
          sourceX,
          sourceY,
          sourceSize,
          sourceSize,
          0,
          0,
          avatarSize,
          avatarSize,
        );
        resolve(canvas.toDataURL("image/webp", 0.86));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });

const localDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const contributionDays = (usage: CodexUsageSnapshot) => {
  const totals = new Map(usage.days.map((day) => [day.date, day.totalTokens]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 363);
  const days = Array.from({ length: 364 }, (_, index) => {
    const date = new Date(start);
    date.setDate(date.getDate() + index);
    return { date, key: localDateKey(date), tokens: totals.get(localDateKey(date)) ?? 0 };
  });
  const max = Math.max(0, ...days.map((day) => day.tokens));
  return days.map((day) => ({
    ...day,
    level: day.tokens === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((day.tokens / max) * 4)),
  }));
};

export function ProfilePage({
  accountUsage,
  profile,
  runtime,
  usage,
  contributions,
  onClose,
  onSaveProfile,
}: ProfilePageProps) {
  const [editing, setEditing] = useState(!profile.name);
  const [draftName, setDraftName] = useState(profile.name);
  const [draftAvatar, setDraftAvatar] = useState(profile.avatarDataUrl);
  const [profileError, setProfileError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const initials = profileInitials(profile.name);
  const accountDays = accountUsage?.dailyUsageBuckets.map((bucket) => ({
    date: bucket.startDate.slice(0, 10),
    totalTokens: bucket.tokens,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }));
  const activityUsage: CodexUsageSnapshot = accountUsage
    ? {
        days: accountDays ?? [],
        totals: {
          ...usage.totals,
          totalTokens:
            accountUsage.lifetimeTokens ??
            accountDays?.reduce((sum, day) => sum + day.totalTokens, 0) ??
            usage.totals.totalTokens,
        },
        activeDays: accountDays?.filter((day) => day.totalTokens > 0).length ?? 0,
        currentStreak: accountUsage.currentStreakDays ?? 0,
        longestStreak: accountUsage.longestStreakDays ?? 0,
      }
    : usage;
  const days = contributionDays(activityUsage);
  const monthLabels = days.filter((day, index) => day.date.getDate() <= 7 && index % 7 === 0);
  const connected = runtime.phase === "ready" || runtime.phase === "working";
  const peakDay = activityUsage.days.reduce<(typeof activityUsage.days)[number] | null>(
    (peak, day) => !peak || day.totalTokens > peak.totalTokens ? day : peak,
    null,
  );

  const openEditor = () => {
    setDraftName(profile.name);
    setDraftAvatar(profile.avatarDataUrl);
    setProfileError(null);
    setEditing(true);
  };

  const closeEditor = () => {
    if (!profile.name) {
      onClose();
      return;
    }
    setEditing(false);
  };

  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      setDraftAvatar(await createAvatar(file));
      setProfileError(null);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Xiao could not use that image.");
    }
  };

  const saveProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = draftName.trim();
    if (!name) {
      setProfileError("Enter the name you want Xiao to use.");
      return;
    }
    onSaveProfile({ name, avatarDataUrl: draftAvatar });
    setEditing(false);
  };

  return (
    <section className="profile-page">
      <header className="profile-hero">
        <div className="profile-hero__inner">
          <div className="profile-identity">
            <button className="profile-avatar" type="button" onClick={openEditor} aria-label="Edit profile">
              {profile.avatarDataUrl ? (
                <img src={profile.avatarDataUrl} alt="" />
              ) : initials ? (
                initials
              ) : (
                <XiaoIcon name="user" size={24} />
              )}
            </button>
            <div>
              <span className="profile-eyebrow">Local identity</span>
              <h1>{profile.name || "Set up your profile"}</h1>
              <p>
                {profile.name
                  ? "Your private identity across Xiao tasks"
                  : "Add the name and photo Xiao should use"}
              </p>
            </div>
          </div>

          <div className="profile-hero__actions">
            <span
              className={connected ? "profile-connection is-connected" : "profile-connection"}
              role="status"
            >
              <i /> {connected ? "Codex connected" : "Reconnecting"}
            </span>
            <button className="profile-edit-button" type="button" onClick={openEditor}>
              <XiaoIcon name="edit" size={14} />
              <span>Edit profile</span>
            </button>
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close profile">
              <XiaoIcon name="close" size={14} />
            </button>
          </div>

          <div className="profile-hero__usage">
            <span>Xiao contributions</span>
            <strong>{fullNumber.format(contributions.tasksCompleted)}</strong>
            <small>completed tasks in the loaded workspace</small>
          </div>
        </div>
      </header>

      <div className="profile-dashboard">
        <section className="profile-activity" aria-labelledby="profile-activity-title">
          <header className="profile-section-heading">
            <div>
              <span>365-day signal</span>
              <h2 id="profile-activity-title">Codex activity</h2>
            </div>
            <p>Account usage in your local timezone</p>
          </header>

          <div className="profile-activity__body">
            <div className="profile-heatmap">
              <div className="contribution-months" aria-hidden="true">
                {monthLabels.map((day) => <span key={day.key}>{monthLabel.format(day.date)}</span>)}
              </div>
              <div className="profile-heatmap__plot">
                <div className="profile-heatmap__weekdays" aria-hidden="true">
                  <span>M</span>
                  <span>W</span>
                  <span>F</span>
                </div>
                <div className="contribution-grid" aria-label="Token activity over the last year">
                  {days.map((day) => (
                    <span
                      className={`contribution-day level-${day.level}`}
                      key={day.key}
                      title={`${dayLabel.format(day.date)}: ${fullNumber.format(day.tokens)} tokens`}
                    />
                  ))}
                </div>
              </div>
              <footer className="profile-heatmap__legend">
                <span>Less</span>
                {[0, 1, 2, 3, 4].map((level) => <i className={`level-${level}`} key={level} />)}
                <span>More</span>
              </footer>
            </div>

            <aside className="profile-activity__summary" aria-label="Activity summary">
              <div className="profile-streak">
                <span>Current streak</span>
                <strong>{activityUsage.currentStreak}<small>days</small></strong>
                <p>
                  {activityUsage.currentStreak
                    ? "Keep the signal alive with another Xiao task today."
                    : "Start a Xiao task today to begin a new streak."}
                </p>
              </div>
              <dl>
                <div>
                  <dt>Longest streak</dt>
                  <dd>{activityUsage.longestStreak} days</dd>
                </div>
                <div>
                  <dt>Active days</dt>
                  <dd>{activityUsage.activeDays}</dd>
                </div>
                <div>
                  <dt>Peak day</dt>
                  <dd title={peakDay ? `${fullNumber.format(peakDay.totalTokens)} tokens` : undefined}>
                    {peakDay ? new Date(`${peakDay.date}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "--"}
                  </dd>
                </div>
                <div>
                  <dt>Window</dt>
                  <dd>365 days</dd>
                </div>
              </dl>
            </aside>
          </div>
        </section>

        <section className="profile-ledger profile-contributions" aria-labelledby="profile-ledger-title">
          <header className="profile-section-heading">
            <div>
              <span>Local craft</span>
              <h2 id="profile-ledger-title">Xiao contributions</h2>
            </div>
            <p>Derived from locally saved task activity</p>
          </header>

          <div className="profile-contribution-grid">
            <article><span><XiaoIcon name="check" size={16} /></span><strong>{fullNumber.format(contributions.tasksCompleted)}</strong><small>Tasks completed</small></article>
            <article><span><XiaoIcon name="branch" size={16} /></span><strong>{fullNumber.format(contributions.repositoriesReviewed)}</strong><small>Repos reviewed</small></article>
            <article><span><XiaoIcon name="mutation" size={16} /></span><strong>{fullNumber.format(contributions.filesModified)}</strong><small>Files modified</small></article>
            <article><span><XiaoIcon name="command" size={16} /></span><strong>{fullNumber.format(contributions.terminalCommandsExecuted)}</strong><small>Commands executed</small></article>
          </div>

          <footer className="profile-ledger__note">
            <XiaoIcon name="result" size={15} />
            <p>
              Contributions stay on this device. Token totals and quota analytics live in Usage.
            </p>
          </footer>
        </section>
      </div>

      {editing ? (
        <div className="profile-modal" role="presentation">
          <form
            className="profile-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-editor-title"
            onSubmit={saveProfile}
          >
            <header>
              <span className="profile-eyebrow">Personalize Xiao</span>
              <h2 id="profile-editor-title">{profile.name ? "Edit profile" : "Create your profile"}</h2>
              <p>Your name and photo stay on this device.</p>
            </header>

            <div className="profile-avatar-editor">
              <button
                className={`profile-avatar-picker ${draftAvatar ? "has-image" : ""}`}
                type="button"
                aria-label="Choose profile photo"
                onClick={() => avatarInputRef.current?.click()}
              >
                {draftAvatar ? (
                  <img src={draftAvatar} alt="Profile preview" />
                ) : draftName.trim() ? (
                  profileInitials(draftName)
                ) : (
                  <XiaoIcon name="user" size={25} />
                )}
                <span><XiaoIcon name="edit" size={12} /></span>
              </button>
              <div>
                <strong>Profile photo</strong>
                <p>Choose a clear square image. Xiao will crop it automatically.</p>
                <div className="profile-avatar-actions">
                  <button type="button" onClick={() => avatarInputRef.current?.click()}>
                    {draftAvatar ? "Change photo" : "Choose photo"}
                  </button>
                  {draftAvatar ? (
                    <button type="button" onClick={() => setDraftAvatar(null)}>Remove</button>
                  ) : null}
                </div>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => void chooseAvatar(event)}
              />
            </div>

            <label className="profile-name-field">
              <span>Display name</span>
              <input
                autoFocus
                maxLength={40}
                placeholder="How should Xiao call you?"
                value={draftName}
                onChange={(event) => {
                  setDraftName(event.target.value);
                  setProfileError(null);
                }}
              />
            </label>
            {profileError ? <p className="profile-editor__error" role="alert">{profileError}</p> : null}

            <footer>
              <button className="profile-editor__cancel" type="button" onClick={closeEditor}>
                {profile.name ? "Cancel" : "Not now"}
              </button>
              <button className="profile-editor__save" type="submit">Save profile</button>
            </footer>
          </form>
        </div>
      ) : null}
    </section>
  );
}
