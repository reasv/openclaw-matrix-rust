use chrono::{DateTime, Utc};
use matrix_sdk::{
    Room,
    ruma::events::{
        room::message::{
            FormattedBody, MessageType, OriginalSyncRoomMessageEvent, Relation,
            RoomMessageEventContent,
        },
    },
};

use crate::api::{
    MatrixChatType, MatrixInboundEvent, MatrixInboundMedia, MatrixMediaKind,
};

fn timestamp_from_event(event: &OriginalSyncRoomMessageEvent) -> DateTime<Utc> {
    let millis = i64::from(event.origin_server_ts.get());
    DateTime::from_timestamp_millis(millis).unwrap_or_else(Utc::now)
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
        reply_to_id,
        thread_root_id,
        timestamp: timestamp_from_event(event),
        media: media_items(&event.content.msgtype),
    })
}
