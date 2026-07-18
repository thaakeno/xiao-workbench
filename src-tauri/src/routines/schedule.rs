use chrono::{DateTime, Duration, LocalResult, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

use super::models::{RoutineScheduleKind, RoutineSchedulePayload};

const MAX_GAP_MINUTES: i64 = 180;
const MAX_SEARCH_DAYS: usize = 370;

pub(crate) fn build_schedule(
    kind: RoutineScheduleKind,
    timezone: &str,
    scheduled_for: Option<i64>,
    daily_time: Option<&str>,
    now: i64,
) -> Result<(RoutineSchedulePayload, i64), String> {
    let timezone = parse_timezone(timezone)?;
    match kind {
        RoutineScheduleKind::OneShot => {
            let scheduled_for = scheduled_for
                .filter(|value| *value > 0)
                .ok_or("A one-shot routine requires a valid scheduled time.")?;
            Ok((
                RoutineSchedulePayload {
                    scheduled_for: Some(scheduled_for),
                    hour: None,
                    minute: None,
                },
                scheduled_for,
            ))
        }
        RoutineScheduleKind::Daily => {
            let (hour, minute) = parse_daily_time(
                daily_time.ok_or("A daily routine requires a local wall-clock time.")?,
            )?;
            let payload = RoutineSchedulePayload {
                scheduled_for: None,
                hour: Some(hour),
                minute: Some(minute),
            };
            let next = next_daily_after(timezone, hour, minute, now.saturating_sub(1))?;
            Ok((payload, next))
        }
    }
}

pub(crate) fn next_after(
    kind: RoutineScheduleKind,
    timezone: &str,
    payload: &RoutineSchedulePayload,
    after: i64,
) -> Result<Option<i64>, String> {
    match kind {
        RoutineScheduleKind::OneShot => Ok(None),
        RoutineScheduleKind::Daily => {
            let timezone = parse_timezone(timezone)?;
            let hour = payload
                .hour
                .ok_or("The daily routine schedule has no hour.")?;
            let minute = payload
                .minute
                .ok_or("The daily routine schedule has no minute.")?;
            next_daily_after(timezone, hour, minute, after).map(Some)
        }
    }
}

pub(crate) fn daily_time(payload: &RoutineSchedulePayload) -> Option<String> {
    Some(format!("{:02}:{:02}", payload.hour?, payload.minute?))
}

fn parse_timezone(value: &str) -> Result<Tz, String> {
    value
        .parse::<Tz>()
        .map_err(|_| format!("Unsupported IANA timezone `{value}`."))
}

fn parse_daily_time(value: &str) -> Result<(u32, u32), String> {
    let (hour, minute) = value
        .split_once(':')
        .ok_or("Daily time must use HH:MM format.")?;
    if hour.len() != 2 || minute.len() != 2 {
        return Err("Daily time must use HH:MM format.".to_owned());
    }
    let hour = hour
        .parse::<u32>()
        .map_err(|_| "Daily hour is invalid.".to_owned())?;
    let minute = minute
        .parse::<u32>()
        .map_err(|_| "Daily minute is invalid.".to_owned())?;
    NaiveTime::from_hms_opt(hour, minute, 0)
        .ok_or("Daily time is outside the valid 00:00-23:59 range.")?;
    Ok((hour, minute))
}

fn next_daily_after(timezone: Tz, hour: u32, minute: u32, after: i64) -> Result<i64, String> {
    let after_utc = DateTime::<Utc>::from_timestamp_millis(after)
        .ok_or("The routine comparison timestamp is invalid.")?;
    let mut date = after_utc.with_timezone(&timezone).date_naive();
    let time = NaiveTime::from_hms_opt(hour, minute, 0)
        .ok_or("The daily routine wall-clock time is invalid.")?;

    for _ in 0..MAX_SEARCH_DAYS {
        let candidate = local_candidate(timezone, date.and_time(time))?;
        let candidate_ms = candidate.with_timezone(&Utc).timestamp_millis();
        if candidate_ms > after {
            return Ok(candidate_ms);
        }
        date = date
            .succ_opt()
            .ok_or("The daily routine date exceeded the supported range.")?;
    }
    Err("Could not find the next daily routine occurrence.".to_owned())
}

fn local_candidate(timezone: Tz, local: NaiveDateTime) -> Result<DateTime<Tz>, String> {
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok(value),
        LocalResult::Ambiguous(first, second) => Ok(first.min(second)),
        LocalResult::None => {
            for minutes in 1..=MAX_GAP_MINUTES {
                let shifted = local
                    .checked_add_signed(Duration::minutes(minutes))
                    .ok_or("The routine DST adjustment exceeded the supported range.")?;
                match timezone.from_local_datetime(&shifted) {
                    LocalResult::Single(value) => return Ok(value),
                    LocalResult::Ambiguous(first, second) => return Ok(first.min(second)),
                    LocalResult::None => {}
                }
            }
            Err("The routine local time did not become valid after a DST gap.".to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    fn utc_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn next_daily_occurrence_uses_local_wall_clock() {
        let next = next_daily_after(
            "Asia/Ho_Chi_Minh".parse().unwrap(),
            9,
            30,
            utc_ms(2026, 7, 17, 0, 0),
        )
        .unwrap();
        assert_eq!(next, utc_ms(2026, 7, 17, 2, 30));
    }

    #[test]
    fn spring_gap_uses_first_valid_instant_after_gap() {
        let next = next_daily_after(
            "America/New_York".parse().unwrap(),
            2,
            30,
            utc_ms(2024, 3, 10, 0, 0),
        )
        .unwrap();
        assert_eq!(next, utc_ms(2024, 3, 10, 7, 0));
    }

    #[test]
    fn fall_fold_uses_earlier_occurrence_once() {
        let next = next_daily_after(
            "America/New_York".parse().unwrap(),
            1,
            30,
            utc_ms(2024, 11, 3, 0, 0),
        )
        .unwrap();
        assert_eq!(next, utc_ms(2024, 11, 3, 5, 30));
        let following = next_daily_after("America/New_York".parse().unwrap(), 1, 30, next).unwrap();
        assert_eq!(following, utc_ms(2024, 11, 4, 6, 30));
    }

    #[test]
    fn schedule_input_rejects_invalid_timezone_and_time() {
        assert!(
            build_schedule(RoutineScheduleKind::Daily, "Local", None, Some("09:30"), 1,).is_err()
        );
        assert!(
            build_schedule(RoutineScheduleKind::Daily, "UTC", None, Some("24:00"), 1,).is_err()
        );
    }
}
