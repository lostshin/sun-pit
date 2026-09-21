#!/usr/bin/env python3
"""Generate a .shortcut plist for saving X posts into an Obsidian vault.

Schema was reverse-engineered from real shortcuts in ~/Library/Shortcuts/Shortcuts.sqlite,
so action identifiers and parameter shapes match the iOS version actually in use.
"""
import json
import plistlib
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
BUILD_DIR = HERE / "build"
CONFIG_PATH = HERE / "config.json"

if not CONFIG_PATH.exists():
    sys.exit(
        "找不到 %s\n"
        "請先 cp config.example.json config.json，再依 README 用探針捷徑填入 vault_folder。"
        % CONFIG_PATH
    )
CONFIG = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

# 只存自己的貼文：剪貼簿可能殘留別人的連結，那不該進「個人創作」
SCREEN_NAME = CONFIG["screen_name"]
# 由實機探針捷徑取得，含裝置專屬 ID，所以放在未進版控的 config.json
VAULT_FOLDER = CONFIG["vault_folder"]
SHORTCUT_NAME = CONFIG.get("shortcut_name", "順筆・手機補記")
PLACEHOLDER = "￼"

actions = []


def new_uuid():
    return str(uuid.uuid4()).upper()


def token_string(template, variables):
    """Build a WFTextTokenString. `template` uses {{name}}; `variables` maps name -> attachment."""
    string = ""
    attachments = {}
    rest = template
    while "{{" in rest:
        head, rest = rest.split("{{", 1)
        name, rest = rest.split("}}", 1)
        string += head
        attachments["{%d, 1}" % len(string)] = variables[name]
        string += PLACEHOLDER
    string += rest
    if not attachments:
        return string
    return {
        "Value": {"string": string, "attachmentsByRange": attachments},
        "WFSerializationType": "WFTextTokenString",
    }


def var(name):
    return {"Type": "Variable", "VariableName": name}


def out(action_uuid, name):
    return {"Type": "ActionOutput", "OutputUUID": action_uuid, "OutputName": name}


def attachment(value):
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def add(identifier, params=None):
    actions.append(
        {
            "WFWorkflowActionIdentifier": "is.workflow.actions." + identifier,
            "WFWorkflowActionParameters": params or {},
        }
    )


def set_variable(name, value):
    add("setvariable", {"WFVariableName": name, "WFInput": attachment(value)})


def text_input(value):
    """text.replace / format.date 的輸入必須是 WFTextTokenString（實證），不是 Attachment。
    型別給錯時 Shortcuts 不報錯，只會靜默回傳空值。"""
    return token_string("{{v}}", {"v": value})


def gettext_var(template, variables, variable_name):
    """文字動作 → 設定變數。診斷捷徑證實這是最可靠的取值方式。"""
    u = new_uuid()
    add("gettext", {"UUID": u, "WFTextActionText": token_string(template, variables)})
    set_variable(variable_name, out(u, "文字"))


def if_start(group, condition, value_key=None, value=None, input_value=None):
    params = {
        "GroupingIdentifier": group,
        "WFControlFlowMode": 0,
        "WFCondition": condition,
        "WFInput": {"Type": "Variable", "Variable": attachment(input_value)},
    }
    if value_key:
        params[value_key] = value
    add("conditional", params)


def if_else(group):
    add("conditional", {"GroupingIdentifier": group, "WFControlFlowMode": 1})


def if_end(group):
    add("conditional", {"GroupingIdentifier": group, "WFControlFlowMode": 2})


# 只用實證過的條件值：99 = contains（樣本中確認），100 = has any value（樣本中無運算元的用法）
CONTAINS, HAS_ANY_VALUE = 99, 100

# ---------------------------------------------------------------- A. 取得輸入
# 分享工作表進來時用捷徑輸入，其餘（輕點背面、Siri、捷徑首頁）用剪貼簿。
# 不串接兩者：剪貼簿若殘留另一則貼文連結，正規表達式會抓到兩個 ID。
# 這三個構件（ExtensionInput 取值、Clipboard 取值、contains 判斷）都經診斷捷徑實測。
gettext_var("{{e}}", {"e": {"Type": "ExtensionInput"}}, "捷輸")

g_source = new_uuid()
if_start(g_source, CONTAINS, "WFConditionalActionString", "status/", input_value=var("捷輸"))
gettext_var("{{v}}", {"v": var("捷輸")}, "原始輸入")
if_else(g_source)
gettext_var("{{c}}", {"c": {"Type": "Clipboard"}}, "原始輸入")
if_end(g_source)

# ------------------------------------------------------------ B. 抽出貼文 ID
# 守門用 contains 而非 has any value，並把實際收到的內容放進錯誤訊息方便診斷
g_bad = new_uuid()
if_start(g_bad, CONTAINS, "WFConditionalActionString", "status/", input_value=var("原始輸入"))
if_else(g_bad)
add("exit")          # 靜默結束：自動化情境下不能每次關 App 都跳通知
if_end(g_bad)

# ── 作者檢查：剪貼簿可能殘留別人的貼文連結，那不該進「個人創作」
# 用原始輸入（含帳號）判斷，兩個分支都涵蓋；長貼文的 tombstone 回應沒有 user 欄位
g_author = new_uuid()
if_start(
    g_author,
    CONTAINS,
    "WFConditionalActionString",
    "/%s/" % SCREEN_NAME,
    input_value=var("原始輸入"),
)
if_else(g_author)
add("exit")
if_end(g_author)

# 15 位以上的數字就是貼文 ID（網址尾巴的 ?s=20 之類短數字不會誤中）
u_id = new_uuid()
add(
    "text.match",
    {
        "UUID": u_id,
        "WFMatchTextPattern": "[0-9]{15,}",
        "text": token_string("{{v}}", {"v": var("原始輸入")}),
    },
)
set_variable("貼文ID", out(u_id, "符合的文字"))

u_url = new_uuid()
add(
    "gettext",
    {
        "UUID": u_url,
        "WFTextActionText": token_string(
            "https://x.com/i/status/{{id}}", {"id": var("貼文ID")}
        ),
    },
)
set_variable("貼文網址", out(u_url, "文字"))

# --------------------------------------------------------- C. 呼叫 syndication
u_dl = new_uuid()
add(
    "downloadurl",
    {
        "UUID": u_dl,
        "ShowHeaders": False,
        "WFURL": token_string(
            "https://cdn.syndication.twimg.com/tweet-result?id={{id}}&lang=zh-tw&token=sp2o",
            {"id": var("貼文ID")},
        ),
    },
)

dictionary_input = {
    "Value": {
        "Type": "ActionOutput",
        "OutputUUID": u_dl,
        "OutputName": "URL 的內容",
        "Aggrandizements": [
            {
                "Type": "WFCoercionVariableAggrandizement",
                "CoercionItemClass": "WFDictionaryContentItem",
            }
        ],
    },
    "WFSerializationType": "WFTextTokenAttachment",
}

u_type = new_uuid()
add("getvalueforkey", {"UUID": u_type, "WFDictionaryKey": "__typename", "WFInput": dictionary_input})
gettext_var("{{v}}", {"v": out(u_type, "字典值")}, "型別")

# ------------------------------------------------------------- D. 分流組裝
# 用 contains "Tombstone" 判斷失敗分支：不能用 contains "Tweet" 判斷成功，
# 因為 "TweetTombstone" 也含有 "Tweet"。程式碼順序仍是「成功在前」，
# 最後再把兩段整體對調，讓 Tombstone 落在 if、成功落在 else。
g_main = new_uuid()
if_start(g_main, CONTAINS, "WFConditionalActionString", "Tombstone", input_value=var("型別"))
_branch_a = len(actions)

u_text = new_uuid()
add("getvalueforkey", {"UUID": u_text, "WFDictionaryKey": "text", "WFInput": dictionary_input})
gettext_var("{{v}}", {"v": out(u_text, "字典值")}, "內文")

# 取真實帳號，讓 source_url 與擴充功能一致（巢狀取值：user → screen_name）
u_user = new_uuid()
add("getvalueforkey", {"UUID": u_user, "WFDictionaryKey": "user", "WFInput": dictionary_input})
user_dict_input = {
    "Value": {
        "Type": "ActionOutput",
        "OutputUUID": u_user,
        "OutputName": "辭典值",
        "Aggrandizements": [
            {
                "Type": "WFCoercionVariableAggrandizement",
                "CoercionItemClass": "WFDictionaryContentItem",
            }
        ],
    },
    "WFSerializationType": "WFTextTokenAttachment",
}
u_screen = new_uuid()
add("getvalueforkey", {"UUID": u_screen, "WFDictionaryKey": "screen_name", "WFInput": user_dict_input})
gettext_var("{{v}}", {"v": out(u_screen, "辭典值")}, "帳號")
gettext_var(
    "https://x.com/{{u}}/status/{{id}}",
    {"u": var("帳號"), "id": var("貼文ID")},
    "貼文網址",
)

u_created = new_uuid()
add("getvalueforkey", {"UUID": u_created, "WFDictionaryKey": "created_at", "WFInput": dictionary_input})

# created_at 是字串，format.date 需要日期物件；detect.date 已由測試 B 證實可行
u_date = new_uuid()
gettext_var("{{v}}", {"v": out(u_created, "字典值")}, "時間字串")
add("detect.date", {"UUID": u_date, "WFInput": attachment(var("時間字串"))})

u_disp = new_uuid()
add(
    "format.date",
    {
        "UUID": u_disp,
        "WFDate": text_input(out(u_date, "日期")),
        "WFDateFormatStyle": "Custom",
        "WFDateFormat": "yyyy-MM-dd HH:mm",
        "WFTimeFormatStyle": "Medium",
    },
)
set_variable("顯示時間", out(u_disp, "格式化的日期"))

u_fn = new_uuid()
add(
    "format.date",
    {
        "UUID": u_fn,
        "WFDate": text_input(out(u_date, "日期")),
        "WFDateFormatStyle": "Custom",
        "WFDateFormat": "yyyy-MM-dd_HHmm",
        "WFTimeFormatStyle": "Medium",
    },
)
set_variable("檔名前綴", out(u_fn, "格式化的日期"))

# 換行轉空格 → 雙引號轉單引號（標題與檔名都取自這裡，避免 YAML 被引號截斷）
u_nl = new_uuid()
add(
    "text.replace",
    {
        "UUID": u_nl,
        "WFInput": text_input(var("內文")),
        "WFReplaceTextFind": "\\n",
        "WFReplaceTextReplace": " ",
        "WFReplaceTextRegularExpression": True,
    },
)
u_quote = new_uuid()
add(
    "text.replace",
    {
        "UUID": u_quote,
        "WFInput": text_input(out(u_nl, "更新的文字")),
        "WFReplaceTextFind": '"',
        "WFReplaceTextReplace": "'",
        "WFReplaceTextRegularExpression": False,
    },
)
set_variable("單行", out(u_quote, "更新的文字"))

u_sum = new_uuid()
add(
    "text.match",
    {
        "UUID": u_sum,
        "WFMatchTextPattern": "^[\\s\\S]{1,25}",
        "text": token_string("{{v}}", {"v": var("單行")}),
    },
)
u_safe = new_uuid()
add(
    "text.replace",
    {
        "UUID": u_safe,
        "WFInput": text_input(out(u_sum, "符合的文字")),
        "WFReplaceTextFind": '[\\\\/:*?"<>|]',
        "WFReplaceTextReplace": "",
        "WFReplaceTextRegularExpression": True,
    },
)
set_variable("摘要", out(u_safe, "更新的文字"))

u_title = new_uuid()
add(
    "text.match",
    {
        "UUID": u_title,
        "WFMatchTextPattern": "^[\\s\\S]{1,30}",
        "text": token_string("{{v}}", {"v": var("單行")}),
    },
)
set_variable("標題", out(u_title, "符合的文字"))

published = """---
title: "{{title}}"
created: "{{time}}"
platform: "Twitter/X"
source: "x"
source_url: "{{url}}"
status: "published"
tags:
  - "社群貼文"
  - "Twitter/X"
summary: ""
---

> [!info] 貼文資訊
> **平台**：Twitter/X<br>
> **發佈時間**：{{time}}<br>
> **原始貼文**：[在 Twitter/X 查看](<{{url}}>)

---

## 貼文內容

```
{{body}}
```
"""
u_md = new_uuid()
add(
    "gettext",
    {
        "UUID": u_md,
        "WFTextActionText": token_string(
            published,
            {
                "title": var("標題"),
                "time": var("顯示時間"),
                "url": var("貼文網址"),
                "body": var("內文"),
            },
        ),
    },
)
set_variable("內容", out(u_md, "文字"))

u_name = new_uuid()
add(
    "gettext",
    {
        "UUID": u_name,
        "WFTextActionText": token_string(
            "{{p}}_{{s}}.md", {"p": var("檔名前綴"), "s": var("摘要")}
        ),
    },
)
set_variable("檔名", out(u_name, "文字"))

# ---- tombstone 分支：長貼文，syndication 不給內文 ----
_branch_a_end = len(actions)
if_else(g_main)
_branch_b = len(actions)

u_now_disp = new_uuid()
add(
    "format.date",
    {
        "UUID": u_now_disp,
        "WFDate": text_input({"Type": "CurrentDate"}),
        "WFDateFormatStyle": "Custom",
        "WFDateFormat": "yyyy-MM-dd HH:mm",
        "WFTimeFormatStyle": "Medium",
    },
)
set_variable("存檔時間", out(u_now_disp, "格式化的日期"))

# created 不填執行時間：tombstone 拿不到 created_at，寫當下時間等於在 vault 放假資料。
# 真實發文時間可由 snowflake 反推（(id >> 22) + 1288834974657 毫秒），但 Shortcuts 端
# 缺「調整日期」動作的實機樣本，參數形狀猜錯會靜默回空值，因此留給使用者手動補。
stub = """---
title: "（待補完）"
created: ""
platform: "Twitter/X"
source: "x"
source_url: "{{url}}"
status: "pending-content"
post_id: "{{id}}"
saved_at: "{{time}}"
tags:
  - "社群貼文"
  - "Twitter/X"
summary: ""
---

> [!warning] 內文尚未取得
> **平台**：Twitter/X
> **原始貼文**：[在 Twitter/X 查看](<{{url}}>)
> 長貼文或已刪除的貼文，syndication 端點都不提供內文。
> 補完步驟：①開啟原始貼文複製內文貼到下方 ②填入 `created` ③把檔名改成 `YYYY-MM-DD_HHmm_摘要.md`。

---

## 貼文內容

```

```
"""
u_stub = new_uuid()
add(
    "gettext",
    {
        "UUID": u_stub,
        "WFTextActionText": token_string(
            stub,
            {"time": var("存檔時間"), "url": var("貼文網址"), "id": var("貼文ID")},
        ),
    },
)
set_variable("內容", out(u_stub, "文字"))

# 檔名綁貼文 ID 而非執行時間：同一則貼文重跑會產生同名檔，
# 讓下方既有的「檔案已存在就 exit」把重複擋掉（用執行時間則每分鐘都會多存一份）。
u_stub_name = new_uuid()
add(
    "gettext",
    {
        "UUID": u_stub_name,
        "WFTextActionText": token_string("待補完_{{id}}.md", {"id": var("貼文ID")}),
    },
)
set_variable("檔名", out(u_stub_name, "文字"))

# 兩段分支整體對調：Tombstone 段搬到 if、成功段搬到 else，中間的 else 動作原地不動
_success = actions[_branch_a:_branch_a_end]
_else_action = actions[_branch_a_end]
_stub = actions[_branch_b:len(actions)]
actions[_branch_a:len(actions)] = _stub + [_else_action] + _success

if_end(g_main)

# ---------------------------------------------------------- E. 寫入
# 檔名由 setitemname 決定，資料夾參照來自實機探針（含裝置專屬的 file provider ID）
# 去重：參數 key 與型別取自實機探針（WFGetFilePath 純字串、WFFileErrorIfNotFound 布林）。
# 找不到檔案時回傳空值而非報錯，所以判斷失準時會「傾向存檔」而不是漏存。
u_exists = new_uuid()
add(
    "documentpicker.open",
    {
        "UUID": u_exists,
        "WFFile": VAULT_FOLDER,
        "WFGetFilePath": token_string("{{n}}", {"n": var("檔名")}),
        "WFFileErrorIfNotFound": False,
    },
)
g_dupe = new_uuid()
if_start(g_dupe, HAS_ANY_VALUE, input_value=out(u_exists, "檔案"))
add("exit")          # 已存在就靜默結束
if_end(g_dupe)

u_body = new_uuid()
add("gettext", {"UUID": u_body, "WFTextActionText": token_string("{{c}}", {"c": var("內容")})})

u_named = new_uuid()
add(
    "setitemname",
    {
        "UUID": u_named,
        "WFInput": attachment(out(u_body, "文字")),
        "WFName": token_string("{{n}}", {"n": var("檔名")}),
    },
)

add(
    "documentpicker.save",
    {
        "WFInput": attachment(out(u_named, "重新命名的項目")),
        "WFAskWhereToSave": False,
        "WFFolder": VAULT_FOLDER,
    },
)

add(
    "notification",
    {
        "WFNotificationActionBody": token_string(
            "已存入 Obsidian · {{n}}", {"n": var("檔名")}
        )
    },
)

workflow = {
    "WFWorkflowActions": actions,
    "WFWorkflowClientVersion": "3110.0.3",
    "WFWorkflowMinimumClientVersion": 900,
    "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowHasOutputFallback": False,
    "WFWorkflowHasShortcutInputVariables": True,
    "WFWorkflowIcon": {
        "WFWorkflowIconGlyphNumber": 59511,
        "WFWorkflowIconStartColor": 946986751,
    },
    "WFWorkflowImportQuestions": [],
    "WFWorkflowInputContentItemClasses": [
        "WFURLContentItem",
        "WFStringContentItem",
    ],
    "WFWorkflowTypes": ["ActionExtension"],
    "WFQuickActionSurfaces": [],
}

BUILD_DIR.mkdir(exist_ok=True)
unsigned = BUILD_DIR / ("%s.unsigned.shortcut" % SHORTCUT_NAME)
signed = BUILD_DIR / ("%s.shortcut" % SHORTCUT_NAME)

with open(unsigned, "wb") as handle:
    plistlib.dump(workflow, handle, fmt=plistlib.FMT_BINARY)

print("動作數:", len(actions))
print("未簽名:", unsigned)

# 未簽名的檔案 iOS 不接受；macOS 有 shortcuts CLI 就直接簽好，省一步手動操作
if shutil.which("shortcuts"):
    subprocess.run(
        ["shortcuts", "sign", "-i", str(unsigned), "-o", str(signed), "-m", "anyone"],
        check=True,
    )
    print("已簽名:", signed)
else:
    print("找不到 shortcuts CLI（需 macOS），請自行簽名：")
    print('  shortcuts sign -i "%s" -o "%s" -m anyone' % (unsigned, signed))
