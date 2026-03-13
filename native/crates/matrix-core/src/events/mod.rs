use chrono::{DateTime, Utc};
use matrix_sdk::{
    deserialized_responses::TimelineEvent,
    Room,
    ruma::events::{
        room::message::{
            FormattedBody, MessageType, OriginalSyncRoomMessageEvent, Relation,
            RoomMessageEventContent,
        },
    },
};
use serde_json::Value;

use crate::api::{
    MatrixChatType, MatrixInboundEvent, MatrixInboundMedia, MatrixInboundMentions, MatrixMediaKind,
    MatrixMessageRelatesTo, MatrixMessageSummary,
};

fn timestamp_from_millis(millis: i64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(millis).unwrap_or_else(Utc::now)
}

fn timestamp_from_event(event: &OriginalSyncRoomMessageEvent) -> DateTime<Utc> {
    timestamp_from_millis(i64::from(event.origin_server_ts.get()))
}

fn formatted_body(msgtype: &MessageType) -> Option<String> {
    fn html_body(formatted: Option<&FormattedBody>) -> Option<String> {
        formatted.map(|value| value.body.clone())
    }

    match msgtype {
        MessageType::Audio(content) => html_body(content.formatted_caption()),
        MessageType::Emote(content) => html_body(content.formatted.as_ref()),
        MessageType::File(content) => html_body(content.formatted_caption()),
        MessageType::Image(content) => html_body(content.formatted_caption()),
        MessageType::Notice(content) => html_body(content.formatted.as_ref()),
        MessageType::Text(content) => html_body(content.formatted.as_ref()),
        MessageType::Video(content) => html_body(content.formatted_caption()),
        MessageType::Location(_)
        | MessageType::ServerNotice(_)
        | MessageType::VerificationRequest(_)
        | MessageType::_Custom(_)
        | _ => None,
    }
}

fn media_items(msgtype: &MessageType) -> Vec<MatrixInboundMedia> {
    match msgtype {
        MessageType::Audio(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::Audio,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        MessageType::File(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::File,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        MessageType::Image(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::Image,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        MessageType::Video(content) => vec![MatrixInboundMedia {
            index: 0,
            kind: MatrixMediaKind::Video,
            body: content.caption().map(ToOwned::to_owned),
            filename: Some(content.filename().to_string()),
            content_type: content.info.as_ref().and_then(|info| info.mimetype.clone()),
            size_bytes: content
                .info
                .as_ref()
                .and_then(|info| info.size.map(u64::from)),
        }],
        _ => Vec::new(),
    }
}

fn relation_details(
    content: &RoomMessageEventContent,
) -> (Option<String>, Option<String>, bool) {
    match content.relates_to.as_ref() {
        Some(Relation::Replacement(_)) => (None, None, true),
        Some(Relation::Reply { in_reply_to }) => (
            Some(in_reply_to.event_id.to_string()),
            None,
            false,
        ),
        Some(Relation::Thread(thread)) => (
            thread
                .in_reply_to
                .as_ref()
                .map(|value| value.event_id.to_string()),
            Some(thread.event_id.to_string()),
            false,
        ),
        Some(Relation::_Custom(_)) | Some(_) | None => (None, None, false),
    }
}

fn readable_body(content: &Value) -> String {
    let msgtype = content.get("msgtype").and_then(Value::as_str).map(str::trim);
    let body = content.get("body").and_then(Value::as_str).map(str::trim).unwrap_or("");
    let filename = content
        .get("filename")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    let resolved = if !body.is_empty() {
        body.to_string()
    } else if !filename.is_empty() {
        filename.to_string()
    } else {
        String::new()
    };

    match msgtype {
        Some("m.emote") if !resolved.is_empty() => format!("/me {resolved}"),
        Some("m.emote") => "/me".to_string(),
        Some("m.sticker") if !resolved.is_empty() => format!("[matrix sticker] {resolved}"),
        Some("m.sticker") => "[matrix sticker]".to_string(),
        _ => resolved,
    }
}

fn summary_relation(value: &Value) -> Option<MatrixMessageRelatesTo> {
    let relates_to = value
        .get("content")
        .and_then(|content| content.get("m.relates_to"))?;
    let rel_type = relates_to
        .get("rel_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let event_id = relates_to
        .get("event_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            relates_to
                .get("m.in_reply_to")
                .and_then(|value| value.get("event_id"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });

    if rel_type.is_none() && event_id.is_none() {
        return None;
    }

    Some(MatrixMessageRelatesTo { rel_type, event_id })
}

fn summarize_message_value(value: &Value) -> Option<MatrixMessageSummary> {
    if value.get("type").and_then(Value::as_str) != Some("m.room.message") {
        return None;
    }
    if value
        .get("unsigned")
        .and_then(|value| value.get("redacted_because"))
        .is_some()
    {
        return None;
    }

    let event_id = value.get("event_id").and_then(Value::as_str)?.to_string();
    let sender = value.get("sender").and_then(Value::as_str)?.to_string();
    let timestamp = value
        .get("origin_server_ts")
        .and_then(Value::as_i64)
        .map(timestamp_from_millis)
        .unwrap_or_else(Utc::now);
    let content = value.get("content")?;
    let msgtype = content
        .get("msgtype")
        .and_then(Value::as_str)
        .map(str::to_string);

    Some(MatrixMessageSummary {
        event_id,
        sender,
        body: readable_body(content),
        msgtype,
        timestamp,
        relates_to: summary_relation(value),
    })
}

pub fn summarize_timeline_event(event: &TimelineEvent) -> Option<MatrixMessageSummary> {
    let value: Value = event.raw().deserialize_as_unchecked().ok()?;
    summarize_message_value(&value)
}

pub async fn normalize_inbound_event(
    room: &Room,
    event: &OriginalSyncRoomMessageEvent,
) -> Option<MatrixInboundEvent> {
    let (reply_to_id, thread_root_id, is_replacement) = relation_details(&event.content);
    if is_replacement {
        return None;
    }

    let chat_type = if thread_root_id.is_some() {
        MatrixChatType::Thread
    } else if room.is_direct().await.unwrap_or(false) {
        MatrixChatType::Direct
    } else {
        MatrixChatType::Channel
    };

    let room_name = room.display_name().await.ok().map(|value| value.to_string());
    let room_alias = room.canonical_alias().map(|value| value.to_string());
    let sender_name = room
        .get_member_no_sync(&event.sender)
        .await
        .ok()
        .flatten()
        .map(|member| member.name().to_string());

    Some(MatrixInboundEvent {
        room_id: room.room_id().to_string(),
        event_id: event.event_id.to_string(),
        sender_id: event.sender.to_string(),
        sender_name,
        room_name,
        room_alias,
        chat_type,
        body: event.content.body().to_string(),
        formatted_body: formatted_body(&event.content.msgtype),
        mentions: event.content.mentions.as_ref().map(|mentions| MatrixInboundMentions {
            user_ids: (!mentions.user_ids.is_empty())
                .then(|| mentions.user_ids.iter().map(ToString::to_string).collect()),
            room: mentions.room.then_some(true),
        }),
        reply_to_id,
        thread_root_id,
        timestamp: timestamp_from_event(event),
        media: media_items(&event.content.msgtype),
    })
}
