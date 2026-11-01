#!/usr/bin/env python3
"""Build unsigned, token-free Moa receiver Shortcuts using only the stdlib.

These are receiver workflows, not personal automations. On the iPhone, the user
must connect a supported notification/message automation's explicitly selected
body TEXT to Run Shortcut's input. No notification trigger or hidden notification
property is guessed here. Signing/importing and a real iPhone test are separate.

Wire-format references (read on 2026-10-31):
  https://github.com/electrikmilk/cherri/blob/main/actions/web.cherri
  https://github.com/electrikmilk/cherri/blob/main/actions/basic.cherri
  https://github.com/electrikmilk/cherri/blob/main/actions/text.cherri
  https://github.com/electrikmilk/cherri/blob/main/variables.go
  https://github.com/electrikmilk/cherri/blob/main/shortcutgen.go
  https://github.com/electrikmilk/cherri/blob/main/shortcut.go
  https://github.com/findlaywebb/shortcut-lib/blob/main/src/shortcut_lib/schema/actions/download_url.py

The latter independently checks JSON/header envelopes against exported workflows.
WFWorkflowImportQuestions targets the zero-based index of a Text action and its
WFTextActionText parameter, never a nested HTTP-header value. Only the iPhone's
installed copy should contain a dedicated collection key; do not commit that copy.
"""

from __future__ import annotations

import argparse
import plistlib
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENDPOINT = "https://expense-tracker-lake-eight-39.vercel.app/api/shortcuts/ingest"
PROVIDERS = {"toss": "토스", "kb": "KB스타뱅킹"}
HEADER_PREFIX = "Bearer moa_sc_"
ACTION_PREFIX = "is.workflow.actions."


def stable_id(provider: str, label: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"https://moa.local/shortcuts/{provider}/{label}")).upper()


def text(value: str = "", reference: dict | None = None) -> dict:
    """Encode literal text or exactly one inline variable using UTF-16 range 0,1."""
    content: dict = {"string": value}
    if reference is not None:
        content = {"string": "\ufffc", "attachmentsByRange": {"{0, 1}": reference}}
    return {"Value": content, "WFSerializationType": "WFTextTokenString"}


def attachment(reference: dict) -> dict:
    return {"Value": reference, "WFSerializationType": "WFTextTokenAttachment"}


def dictionary(values: dict[str, dict]) -> dict:
    return {
        "Value": {
            "WFDictionaryFieldValueItems": [
                {"WFItemType": 0, "WFKey": text(key), "WFValue": value}
                for key, value in values.items()
            ]
        },
        "WFSerializationType": "WFDictionaryFieldValue",
    }


class Workflow:
    def __init__(self, provider: str):
        self.provider = provider
        self.actions: list[dict] = []

    def add(self, name: str, params: dict | None = None, *, output: str | None = None) -> dict:
        parameters = dict(params or {})
        reference: dict = {}
        if output:
            identifier = stable_id(self.provider, output)
            parameters.update(UUID=identifier, CustomOutputName=output)
            reference = {"Type": "ActionOutput", "OutputUUID": identifier, "OutputName": output}
        self.actions.append({
            "WFWorkflowActionIdentifier": ACTION_PREFIX + name,
            "WFWorkflowActionParameters": parameters,
        })
        return reference

    def stop(self, message: str) -> None:
        # Stop and Output has no clipboard fallback. Shortcuts' ordinary network
        # errors stop the request action; we do not fabricate a successful result.
        self.add("output", {"WFOutput": text(message)})

    def conditional(self, label: str, reference: dict, condition: int, *, value=None) -> str:
        group = stable_id(self.provider, label)
        params = {
            "GroupingIdentifier": group,
            "WFControlFlowMode": 0,
            "WFInput": {"Type": "Variable", "Variable": attachment(reference)},
            "WFCondition": condition,
        }
        if isinstance(value, str):
            params["WFConditionalActionString"] = value
        elif value is not None:
            params["WFNumberValue"] = value
        self.add("conditional", params)
        return group

    def end(self, group: str, *, otherwise: bool = False) -> None:
        self.add("conditional", {
            "GroupingIdentifier": group,
            "WFControlFlowMode": 1 if otherwise else 2,
        })


def build_workflow(provider: str) -> dict:
    app = PROVIDERS[provider]
    workflow = Workflow(provider)
    workflow.add("comment", {"WFCommentActionText": (
        f"모아 · {app} 수집 수신기\n"
        "설치 시 모아 설정에서 만든 해당 연결 전용 헤더값 전체(Bearer …)를 입력하세요. "
        "관리자 접속 키는 사용하지 마세요. 키는 설치된 이 단축어에 저장됩니다.\n"
        "이 파일은 알림 자동화를 설치하지 않습니다. iPhone에서 지원하는 알림/메시지 자동화를 만들고, "
        "명시적으로 선택한 알림 본문 텍스트를 ‘단축어 실행’의 입력으로 연결하세요. "
        "앱 알림 자동화는 iOS 27에서 추가되었으며 iOS 26.6에서는 사용할 수 없습니다. "
        "메시지는 실제 수신하는 경우에만 사용할 수 있습니다.\n"
        "본문 외의 제목·발생 시각·알림 ID는 추측하여 보내지 않습니다. "
        "금융수단은 서버의 연결 설정으로 결정됩니다. 클립보드를 읽지 않습니다.\n"
        "전송 결과는 서버 응답 그대로 출력합니다. 수집함에서 저장/확인 상태를 확인하세요. "
        "사용할 아이폰에서 실제 알림의 본문 전달과 잠금 상태 실행을 먼저 확인하세요."
    )})

    question_index = len(workflow.actions)
    header_input = workflow.add("gettext", {"WFTextActionText": ""}, output="수집 전용 헤더")
    header = workflow.add("text.trimwhitespace", {"WFInput": text(reference=header_input)}, output="정리한 헤더")

    missing_header = workflow.conditional("missing-header", header, 101)
    workflow.stop("수집 전용 키가 비어 있어 전송하지 않았습니다. 모아 설정의 헤더값 전체(Bearer …)를 입력하세요.")
    workflow.end(missing_header)

    # The dedicated token generated by backend/src/shortcuts.js begins moa_sc_.
    # This prefix guard also rejects a pasted master/admin access key. The server
    # remains the authority for credential validity; no real token exists here.
    header_prefix = workflow.conditional("dedicated-header-prefix", header, 8, value=HEADER_PREFIX)
    workflow.end(header_prefix, otherwise=True)
    workflow.stop("수집 전용 헤더 형식을 확인하세요. ‘Bearer moa_sc_…’ 전체를 입력해야 합니다.")
    workflow.end(header_prefix)

    header_length = workflow.add("count", {"Input": attachment(header), "WFCountType": "Characters"}, output="헤더 글자 수")
    incomplete_header = workflow.conditional("incomplete-header", header_length, 0, value=len(HEADER_PREFIX) + 1)
    workflow.stop("수집 전용 키가 완성되지 않아 전송하지 않았습니다. 모아에서 복사한 헤더값 전체를 입력하세요.")
    workflow.end(incomplete_header)

    # ExtensionInput is the documented/compiler global Shortcut Input. There is
    # deliberately no guessed Notification.Body aggrandizement. The automation
    # must pass its chosen body as text rather than a notification object.
    incoming = workflow.add("detect.text", {"WFInput": attachment({"Type": "ExtensionInput"})}, output="입력 본문")
    body = workflow.add("text.trimwhitespace", {"WFInput": text(reference=incoming)}, output="전송 본문")
    missing_body = workflow.conditional("missing-body", body, 101)
    workflow.stop("입력 본문이 비어 있어 전송하지 않았습니다. 알림/메시지 본문 텍스트를 이 단축어의 입력으로 연결하세요.")
    workflow.end(missing_body)

    response = workflow.add("downloadurl", {
        "WFURL": text(DEFAULT_ENDPOINT),
        "WFHTTPMethod": "POST",
        "WFHTTPBodyType": "JSON",
        "ShowHeaders": True,
        "WFHTTPHeaders": dictionary({
            "Authorization": text(reference=header),
            "Content-Type": text("application/json"),
        }),
        "WFJSONValues": dictionary({"body": text(reference=body), "source_app": text(app)}),
    }, output="모아 수집 응답")
    workflow.add("output", {"WFOutput": text(reference=response)})

    return {
        "WFWorkflowActions": workflow.actions,
        "WFWorkflowClientVersion": "4528.0.4.2",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {},
        "WFQuickActionSurfaces": [],
        "WFWorkflowTypes": ["WFWorkflowTypeShowInSearch"],
        "WFWorkflowInputContentItemClasses": ["WFStringContentItem"],
        "WFWorkflowOutputContentItemClasses": ["WFStringContentItem"],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowNoInputBehavior": {
            "Name": "WFWorkflowNoInputBehaviorShowError",
            "Parameters": {"Error": "알림/메시지 본문 텍스트를 이 단축어의 입력으로 전달하세요. 빈 입력은 전송하지 않습니다."},
        },
        "WFWorkflowImportQuestions": [{
            "Category": "Parameter",
            "ActionIndex": question_index,
            "ParameterKey": "WFTextActionText",
            "Text": f"모아 설정에서 만든 {app} 연결의 ‘헤더값 복사’ 값을 붙여넣으세요. Bearer 로 시작하는 전체 값이며 관리자 접속 키가 아닙니다.",
            "DefaultValue": "",
        }],
    }


def write_workflows(output_dir: Path) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    for provider in PROVIDERS:
        path = output_dir / f"moa-{provider}.plist"
        path.write_bytes(plistlib.dumps(build_workflow(provider), fmt=plistlib.FMT_XML, sort_keys=False))
        paths.append(path)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description="Build unsigned, credential-free Moa receiver workflows; no network or signing.")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "shortcuts" / "unsigned")
    args = parser.parse_args()
    for path in write_workflows(args.output_dir):
        print(path)


if __name__ == "__main__":
    main()
