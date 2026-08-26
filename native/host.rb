#!/usr/bin/ruby

require 'base64'
require 'cgi'
require 'date'
require 'digest'
require 'fileutils'
require 'json'
require 'open3'
require 'pathname'
require 'securerandom'
require 'set'
require 'tempfile'
require 'time'
require 'tmpdir'
require 'uri'
require 'yaml'

# Chrome 啟動 Native Messaging host 時不帶 LANG，Ruby 的 external 與 filesystem encoding
# 會退成 US-ASCII；中文檔名讀出來即非 UTF-8，與 UTF-8 正文串接會炸 incompatible
# character encodings，整批封存與掃描因此沉默失敗。必須在任何檔案操作前固定成 UTF-8。
Encoding.default_external = Encoding::UTF_8

HOST_VERSION = '1.9.2'
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
APP_DIRECTORY = ENV.fetch(
  'SP2O_CONFIG_DIR',
  File.join(Dir.home, 'Library', 'Application Support', 'Social Post to Obsidian')
)
CONFIG_PATH = File.join(APP_DIRECTORY, 'config.json')

def read_message
  header = STDIN.read(4)
  return nil if header.nil? || header.empty?
  raise 'Invalid native message header' unless header.bytesize == 4

  length = header.unpack1('L<')
  raise 'Native message is too large' if length > MAX_MESSAGE_BYTES

  payload = STDIN.read(length)
  raise 'Native message ended early' unless payload&.bytesize == length

  payload.force_encoding(Encoding::UTF_8)
  raise 'Native message is not valid UTF-8' unless payload.valid_encoding?

  JSON.parse(payload)
end

def write_message(message)
  payload = JSON.generate(message).encode('UTF-8')
  STDOUT.write([payload.bytesize].pack('L<'))
  STDOUT.write(payload)
  STDOUT.flush
end

def load_config
  return {} unless File.file?(CONFIG_PATH)

  JSON.parse(File.read(CONFIG_PATH, encoding: 'UTF-8'))
rescue JSON::ParserError
  {}
end

def save_config(config)
  FileUtils.mkdir_p(APP_DIRECTORY)
  temporary = "#{CONFIG_PATH}.tmp-#{Process.pid}-#{SecureRandom.hex(4)}"
  File.write(temporary, JSON.pretty_generate(config), mode: 'w', encoding: 'UTF-8')
  File.chmod(0o600, temporary)
  File.rename(temporary, CONFIG_PATH)
ensure
  File.delete(temporary) if defined?(temporary) && File.exist?(temporary)
end

class HostActionError < StandardError
  attr_reader :code

  def initialize(message, code)
    super(message)
    @code = code
  end
end

def subprocess_utf8(value, invalid_message, scrub: false)
  text = value.to_s.dup.force_encoding(Encoding::UTF_8)
  text = text.scrub unless text.valid_encoding?
  # `scrub` marks caller-owned subprocess diagnostics; always make them safe to embed.
  scrub ? text.scrub : text
end

def validate_folder(path)
  expanded = File.expand_path(path.to_s)
  raise 'Storage folder does not exist' unless File.directory?(expanded)
  raise 'Storage folder is not writable' unless File.writable?(expanded)

  File.realpath(expanded)
end

def configured_vault
  config = load_config
  path = config['folderPath'] || config['vaultPath']
  raise 'Storage folder is not configured' if path.nil? || path.empty?

  if config['folderPath'].to_s.empty? && !config['vaultPath'].to_s.empty?
    migrated = config.merge('folderPath' => path)
    migrated.delete('vaultPath')
    save_config(migrated)
  end

  validate_folder(path)
end

def safe_parts(relative_path)
  path = relative_path.to_s
  parts = path.split('/').reject(&:empty?)
  if path.start_with?('/') || parts.empty? || parts.any? { |part| part == '.' || part == '..' || part.include?("\0") }
    raise 'Invalid storage path'
  end
  parts
end

def walk_directories(root, parts, create_directories: false)
  current = root
  parts.each do |part|
    current = File.join(current, part)
    raise 'Symbolic links are not allowed in storage paths' if File.symlink?(current)
    if File.exist?(current)
      raise 'Storage path component is not a folder' unless File.directory?(current)
    elsif create_directories
      begin
        Dir.mkdir(current)
      rescue Errno::EEXIST
        # 多個 host 程序可能同時建立同一層資料夾（圖片平行寫入）
        raise 'Storage path component is not a folder' unless File.directory?(current)
      end
    else
      return nil
    end
  end
  current
end

def resolve_target(root, relative_path, create_directories: false)
  parts = safe_parts(relative_path)
  filename = parts.pop
  directory = walk_directories(root, parts, create_directories: create_directories)
  return nil if directory.nil?

  target = File.join(directory, filename)
  raise 'Symbolic links are not allowed in storage paths' if File.symlink?(target)
  target
end

def resolve_directory(root, relative_path)
  walk_directories(root, safe_parts(relative_path))
end

def atomic_write(path, bytes)
  FileUtils.mkdir_p(File.dirname(path))
  temporary = "#{path}.sp2o-tmp-#{Process.pid}-#{SecureRandom.hex(4)}"
  File.open(temporary, 'wb') do |file|
    file.write(bytes)
    file.flush
    file.fsync
  end
  File.rename(temporary, path)
ensure
  File.delete(temporary) if defined?(temporary) && File.exist?(temporary)
end

def choose_folder
  script = 'POSIX path of (choose folder with prompt "Choose a Markdown storage folder")'
  output, error, status = Open3.capture3('/usr/bin/osascript', '-e', script)
  output = subprocess_utf8(output, 'Folder selection returned invalid UTF-8')
  error = subprocess_utf8(error, 'Folder selection returned invalid UTF-8', scrub: true)
  raise(error.strip.empty? ? 'Folder selection was cancelled' : error.strip) unless status.success?

  validate_folder(output.strip)
end

def icloud_drive_path?(path)
  mobile_documents = File.join(Dir.home, 'Library', 'Mobile Documents')
  expanded = File.expand_path(path)
  expanded == mobile_documents || expanded.start_with?(mobile_documents + File::SEPARATOR)
end

def move_to_trash(path)
  script = <<~APPLESCRIPT
    on run argv
      set targetFile to POSIX file (item 1 of argv) as alias
      tell application "Finder" to delete targetFile
    end run
  APPLESCRIPT
  _output, error, status = Open3.capture3('/usr/bin/osascript', '-e', script, path)
  error = subprocess_utf8(error, 'Finder returned invalid UTF-8', scrub: true)
  return if status.success? && !File.exist?(path)

  detail = error.strip
  if detail.include?('-1743')
    raise 'macOS 拒絕 Finder 自動化；請到「系統設定 > 隱私權與安全性 > 自動化」允許 Google Chrome 控制 Finder。'
  end
  raise(detail.empty? ? 'Finder could not move the storage file to Trash' : detail)
end

def remove_file(path)
  # Chrome-launched native hosts can be denied unlink access to iCloud Drive.
  if icloud_drive_path?(path)
    move_to_trash(path)
  else
    File.delete(path)
  end
rescue Errno::EPERM
  move_to_trash(path)
end

def host_status
  config = load_config
  path = config['folderPath'] || config['vaultPath']
  return { 'ok' => true, 'configured' => false, 'version' => HOST_VERSION } if path.nil? || path.empty?

  vault = configured_vault
  {
    'ok' => true,
    'configured' => true,
    'version' => HOST_VERSION,
    'folderName' => File.basename(vault),
    'vaultName' => File.basename(vault),
    'isObsidianVault' => File.directory?(File.join(vault, '.obsidian'))
  }
rescue StandardError => error
  {
    'ok' => false,
    'configured' => true,
    'version' => HOST_VERSION,
    'error' => error.message
  }
end

def run_notes_script(script, *arguments)
  osascript = ENV.fetch('SP2O_OSASCRIPT', '/usr/bin/osascript')
  output, error, status = Open3.capture3(osascript, '-e', script, '--', *arguments.map(&:to_s))
  output = subprocess_utf8(output, 'Apple 備忘錄回傳的文字不是有效的 UTF-8')
  error = subprocess_utf8(error, 'Apple 備忘錄回傳的錯誤不是有效的 UTF-8', scrub: true)
  return output if status.success?

  detail = error.strip
  if detail.include?('-1743')
    raise HostActionError.new(
      'macOS 拒絕 Apple 備忘錄自動化；請到「系統設定 > 隱私權與安全性 > 自動化」允許 Google Chrome 控制備忘錄。',
      'AUTOMATION_DENIED'
    )
  end
  if detail.include?('-600') || detail.match?(/isn.t running/i)
    raise HostActionError.new('Apple 備忘錄目前無法啟動', 'NOTES_UNAVAILABLE')
  end
  raise(detail.empty? ? 'Apple 備忘錄沒有回應' : detail)
end

def private_tempfile(prefix, bytes)
  Tempfile.create(prefix) do |file|
    file.binmode
    file.write(bytes)
    file.flush
    file.fsync
    File.chmod(0o600, file.path)
    yield file.path
  end
end

def private_named_tempfile(name, bytes)
  filename = File.basename(name.to_s)
  raise 'Invalid attachment name' unless filename.match?(/\Aimage-\d{2}\.[a-z0-9]+\z/i)

  Dir.mktmpdir('sp2o-attachment-') do |directory|
    path = File.join(directory, filename)
    File.binwrite(path, bytes)
    File.chmod(0o600, path)
    yield path
  end
end

def notes_locations
  script = <<~APPLESCRIPT
    set oldDelimiters to AppleScript's text item delimiters
    set recordSeparator to ASCII character 30
    set unitSeparator to ASCII character 31
    set outputText to ""
    tell application "Notes"
      repeat with noteAccount in accounts
        repeat with noteFolder in folders of noteAccount
          set outputText to outputText & (id of noteAccount) & unitSeparator & (name of noteAccount) & unitSeparator & (id of noteFolder) & unitSeparator & (name of noteFolder) & recordSeparator
        end repeat
      end repeat
    end tell
    set AppleScript's text item delimiters to oldDelimiters
    return outputText
  APPLESCRIPT
  output = run_notes_script(script)
  locations = output.split("\x1E").map do |row|
    account_id, account_name, folder_id, folder_name = row.split("\x1F", 4)
    next if folder_name.nil?

    {
      'accountId' => account_id,
      'accountName' => account_name,
      'folderId' => folder_id,
      'folderName' => folder_name.strip
    }
  end.compact
  { 'ok' => true, 'locations' => locations }
end

def notes_identity_marker(html, external_key)
  legacy_marker = %(data-sp2o-key="#{external_key}")
  return legacy_marker if html.include?(legacy_marker)

  decoded = CGI.unescapeHTML(html.to_s)
  source_label = decoded.index('來源：') || decoded.index('來源:')
  return nil if source_label.nil?

  source_region = decoded[source_label, 1024].to_s
  case external_key
  when /\Ax:(\d+)\z/
    expected_id = Regexp.last_match(1)
    pattern = %r{https?://(?:www\.)?(?:x|twitter)\.com/[^/\s"'<>]+/status/(\d+)(?=[/?#\s"'<>]|$)}i
    offset = 0
    while (match = pattern.match(source_region, offset))
      return match[0] if match[1] == expected_id

      offset = match.end(0)
    end
  when /\Athreads:(.+)\z/
    expected_code = Regexp.last_match(1)
    pattern = %r{https?://(?:www\.)?threads\.(?:com|net)/@?[^/\s"'<>]+/post/([^/?#\s"'<>]+)(?=[/?#\s"'<>]|$)}i
    offset = 0
    while (match = pattern.match(source_region, offset))
      return match[0] if match[1] == expected_code

      offset = match.end(0)
    end
  else
    return external_key if external_key.match?(/\Ahttps?:\/\//i) && source_region.include?(external_key)
  end
  nil
end

def notes_identity_search_hint(external_key)
  case external_key
  when /\Ax:(\d+)\z/
    "/status/#{Regexp.last_match(1)}"
  when /\Athreads:(.+)\z/
    "/post/#{Regexp.last_match(1)}"
  else
    external_key
  end
end

def notes_find(account_id, folder_id, external_key)
  marker = %(data-sp2o-key="#{external_key}")
  search_hint = notes_identity_search_hint(external_key)
  script = <<~APPLESCRIPT
    on run argv
      set accountId to item 1 of argv
      set folderId to item 2 of argv
      set markerText to item 3 of argv
      set searchHint to item 4 of argv
      set outputText to ""
      tell application "Notes"
        set targetAccount to first account whose id is accountId
        set targetFolder to first folder of targetAccount whose id is folderId
        repeat with targetNote in notes of targetFolder
          set noteBody to body of targetNote
          if noteBody contains markerText or (searchHint is not "" and noteBody contains searchHint) then
            set outputText to outputText & (id of targetNote) & (ASCII character 31) & (name of targetNote) & (ASCII character 30)
          end if
        end repeat
      end tell
      return outputText
    end run
  APPLESCRIPT
  output = run_notes_script(script, account_id, folder_id, marker, search_hint)
  output.split("\x1E").each do |row|
    note_id, title = row.split("\x1F", 2)
    next if note_id.to_s.empty?

    begin
      notes_read_verified(account_id, note_id, external_key)
      return { 'ok' => true, 'found' => true, 'noteId' => note_id, 'title' => title.to_s, 'externalKey' => external_key }
    rescue HostActionError => error
      raise unless %w[NOTES_NOT_FOUND NOTES_IDENTITY_MISMATCH].include?(error.code)
    end
  end

  { 'ok' => true, 'found' => false }
rescue StandardError => error
  raise HostActionError.new('Apple 備忘錄資料夾不存在', 'NOTES_LOCATION_MISSING') if error.message.match?(/Can.t get|Invalid index/i)

  raise
end

def notes_read_verified(account_id, note_id, external_key)
  script = <<~APPLESCRIPT
    on run argv
      set accountId to item 1 of argv
      set noteId to item 2 of argv
      tell application "Notes"
        set targetAccount to first account whose id is accountId
        set targetNote to first note of targetAccount whose id is noteId
        try
          if password protected of targetNote then error "SP2O_NOTE_LOCKED"
        end try
        return body of targetNote
      end tell
    end run
  APPLESCRIPT
  html = run_notes_script(script, account_id, note_id)
  raise HostActionError.new('Apple 備忘錄已鎖定', 'NOTES_LOCKED') if html.include?('SP2O_NOTE_LOCKED')
  marker = notes_identity_marker(html, external_key)
  raise HostActionError.new('Apple 備忘錄身分不符', 'NOTES_IDENTITY_MISMATCH') if marker.nil?

  [html, marker]
rescue HostActionError
  raise
rescue StandardError => error
  raise HostActionError.new('Apple 備忘錄已鎖定', 'NOTES_LOCKED') if error.message.include?('SP2O_NOTE_LOCKED')
  raise HostActionError.new('找不到 Apple 備忘錄', 'NOTES_NOT_FOUND') if error.message.match?(/Can.t get|Invalid index/i)

  raise
end

def notes_read(account_id, note_id, external_key)
  html, = notes_read_verified(account_id, note_id, external_key)
  { 'ok' => true, 'html' => html, 'externalKey' => external_key }
end

def notes_list_posts(account_id, folder_id, cursor, limit)
  offset = [cursor.to_i, 0].max
  page_size = [[limit.to_i, 1].max, 20].min
  script = <<~APPLESCRIPT
    on run argv
      set accountId to item 1 of argv
      set folderId to item 2 of argv
      set startOffset to (item 3 of argv) as integer
      set pageSize to (item 4 of argv) as integer
      set recordSeparator to ASCII character 30
      set unitSeparator to ASCII character 31
      set outputText to ""
      tell application "Notes"
        set targetAccount to first account whose id is accountId
        set targetFolder to first folder of targetAccount whose id is folderId
        set folderNotes to notes of targetFolder
        set noteCount to count of folderNotes
        set firstIndex to startOffset + 1
        set lastIndex to firstIndex + pageSize - 1
        if lastIndex > noteCount then set lastIndex to noteCount
        if firstIndex is less than or equal to noteCount then
          repeat with noteIndex from firstIndex to lastIndex
            set targetNote to item noteIndex of folderNotes
            try
              set createdText to my isoText(creation date of targetNote)
            on error
              set createdText to ""
            end try
            try
              set modifiedText to my isoText(modification date of targetNote)
            on error
              set modifiedText to ""
            end try
            set outputText to outputText & (id of targetNote) & unitSeparator & (name of targetNote) & unitSeparator & createdText & unitSeparator & modifiedText & unitSeparator & (body of targetNote) & recordSeparator
          end repeat
        end if
        return (noteCount as text) & recordSeparator & outputText
      end tell
    end run

    on isoText(dateValue)
      set paddedMonth to text -2 thru -1 of ("0" & ((month of dateValue) as integer))
      set paddedDay to text -2 thru -1 of ("0" & (day of dateValue))
      set paddedHour to text -2 thru -1 of ("0" & (hours of dateValue))
      set paddedMinute to text -2 thru -1 of ("0" & (minutes of dateValue))
      set paddedSecond to text -2 thru -1 of ("0" & (seconds of dateValue))
      return "" & (year of dateValue) & "-" & paddedMonth & "-" & paddedDay & "T" & paddedHour & ":" & paddedMinute & ":" & paddedSecond
    end isoText
  APPLESCRIPT
  output = run_notes_script(script, account_id, folder_id, offset.to_s, page_size.to_s)
  total_text, *rows = output.split("\x1E")
  total = total_text.to_i
  entries = rows.map do |row|
    note_id, title, created_at, modified_at, html = row.split("\x1F", 5)
    next if note_id.to_s.empty?

    {
      'noteId' => note_id,
      'title' => title.to_s,
      'createdAt' => created_at.to_s,
      'modifiedAt' => modified_at.to_s,
      'html' => html.to_s
    }
  end.compact
  next_cursor = offset + entries.length
  {
    'ok' => true,
    'entries' => entries,
    'nextCursor' => next_cursor < total ? next_cursor : nil
  }
rescue StandardError => error
  raise HostActionError.new('Apple 備忘錄資料夾不存在', 'NOTES_LOCATION_MISSING') if error.message.match?(/Can.t get|Invalid index/i)

  raise
end

def notes_export_attachments(account_id, note_id, external_key)
  notes_read_verified(account_id, note_id, external_key)
  Dir.mktmpdir('sp2o-note-attachments-') do |directory|
    script = <<~APPLESCRIPT
      on run argv
        set accountId to item 1 of argv
        set noteId to item 2 of argv
        set outputDirectory to item 3 of argv
        set recordSeparator to ASCII character 30
        set unitSeparator to ASCII character 31
        set outputText to ""
        tell application "Notes"
          set targetAccount to first account whose id is accountId
          set targetNote to first note of targetAccount whose id is noteId
          set attachmentIndex to 0
          repeat with targetAttachment in attachments of targetNote
            set attachmentIndex to attachmentIndex + 1
            try
              set attachmentName to name of targetAttachment
            on error
              set attachmentName to "attachment-" & attachmentIndex
            end try
            set outputPath to outputDirectory & "/attachment-" & attachmentIndex
            save targetAttachment in (POSIX file outputPath)
            set outputText to outputText & attachmentName & unitSeparator & outputPath & recordSeparator
          end repeat
        end tell
        return outputText
      end run
    APPLESCRIPT
    output = run_notes_script(script, account_id, note_id, directory)
    attachments = output.split("\x1E").map do |row|
      name, path = row.split("\x1F", 2)
      next unless path && File.file?(path)

      {
        'name' => name.to_s,
        'path' => path,
        'hash' => Digest::SHA256.file(path).hexdigest
      }
    end.compact
    return yield attachments
  end
end

def notes_attachment_hashes(message)
  notes_export_attachments(
    message.fetch('accountId'), message.fetch('noteId'), message.fetch('externalKey')
  ) do |attachments|
    {
      'ok' => true,
      'hashes' => attachments.map { |attachment| attachment['hash'] },
      'entries' => attachments.map { |attachment| attachment.slice('name', 'hash') }
    }
  end
end

def notes_merge_duplicates(message)
  account_id = message.fetch('accountId')
  folder_id = message.fetch('folderId')
  canonical = message.fetch('canonical')
  duplicates = Array(message['duplicates'])
  all_notes = [canonical, *duplicates]
  verified_html = all_notes.to_h do |note|
    html, = notes_read_verified(account_id, note.fetch('noteId'), note.fetch('externalKey'))
    revision = "sha256:#{Digest::SHA256.hexdigest(html.encode('UTF-8'))}"
    raise HostActionError.new('Apple 備忘錄在掃描後已變更', 'NOTES_REVISION_MISMATCH') unless revision == note.fetch('revision')

    [note.fetch('noteId'), html]
  end

  exports = {}
  export_next = lambda do |index|
    note = all_notes.fetch(index)
    notes_export_attachments(account_id, note.fetch('noteId'), note.fetch('externalKey')) do |attachments|
      exports[note.fetch('noteId')] = attachments.map do |attachment|
        attachment.merge('data' => File.binread(attachment.fetch('path')))
      end
      index + 1 < all_notes.length ? export_next.call(index + 1) : nil
    end
  end
  export_next.call(0) unless all_notes.empty?

  canonical_attachments = exports.fetch(canonical.fetch('noteId'), [])
  seen_hashes = canonical_attachments.map { |attachment| attachment['hash'] }.to_set
  next_number = canonical_attachments.length
  unique = duplicates.flat_map { |note| exports.fetch(note.fetch('noteId'), []) }.map do |attachment|
    next if seen_hashes.include?(attachment['hash'])

    seen_hashes << attachment['hash']
    next_number += 1
    extension = File.extname(attachment['name']).downcase
    extension = '.bin' unless extension.match?(/\A\.[a-z0-9]+\z/i)
    {
      'name' => format('image-%02d%s', next_number, extension),
      'data' => Base64.strict_encode64(attachment['data'])
    }
  end.compact

  notes_upsert({
    'accountId' => account_id,
    'folderId' => folder_id,
    'noteId' => canonical.fetch('noteId'),
    'title' => canonical.fetch('title'),
    'externalKey' => canonical.fetch('externalKey'),
    'html' => canonical.fetch('html'),
    'attachments' => unique
  })
  updated_html, = notes_read_verified(account_id, canonical.fetch('noteId'), canonical.fetch('externalKey'))
  all_notes.each do |note|
    unless notes_identity_marker(updated_html, note.fetch('externalKey'))
      raise HostActionError.new('合併後的 Apple 備忘錄缺少來源識別', 'NOTES_IDENTITY_MISMATCH')
    end
  end
  duplicates.each do |note|
    notes_simple_action('delete', account_id, note.fetch('noteId'), note.fetch('externalKey'))
  end
  { 'ok' => true, 'noteId' => canonical.fetch('noteId'), 'merged' => duplicates.length, 'savedMedia' => unique.length }
end

def notes_attach(message)
  attachment = message.fetch('attachment')
  bytes = Base64.strict_decode64(attachment.fetch('data'))
  script = <<~APPLESCRIPT
    on run argv
      set accountId to item 1 of argv
      set noteId to item 2 of argv
      set attachmentName to item 3 of argv
      set attachmentPath to item 4 of argv
      tell application "Notes"
        set targetAccount to first account whose id is accountId
        set targetNote to first note of targetAccount whose id is noteId
        repeat with oldAttachment in attachments of targetNote
          if name of oldAttachment is attachmentName then delete oldAttachment
        end repeat
        make new attachment at targetNote with data (POSIX file attachmentPath as alias)
      end tell
    end run
  APPLESCRIPT
  private_named_tempfile(attachment.fetch('name'), bytes) do |path|
    run_notes_script(script, message.fetch('accountId'), message.fetch('noteId'), attachment.fetch('name'), path)
  end
  { 'ok' => true, 'savedMedia' => 1, 'failedMedia' => 0 }
end

def notes_upsert(message)
  title = message.fetch('title').to_s
  external_key = message.fetch('externalKey').to_s
  note_id = message['noteId'].to_s
  existing_marker = note_id.empty? ? '' : notes_read_verified(
    message.fetch('accountId'), note_id, external_key
  )[1]
  script = <<~APPLESCRIPT
    on run argv
      set accountId to item 1 of argv
      set folderId to item 2 of argv
      set noteId to item 3 of argv
      set titleText to item 4 of argv
      set htmlPath to item 5 of argv
      set markerText to item 6 of argv
      set htmlFile to open for access POSIX file htmlPath
      set htmlText to read htmlFile as «class utf8»
      close access htmlFile
      tell application "Notes"
        set targetAccount to first account whose id is accountId
        set targetFolder to first folder of targetAccount whose id is folderId
        if noteId is "" then
          set targetNote to make new note at targetFolder with properties {name:titleText, body:htmlText}
        else
          set targetNote to first note of targetAccount whose id is noteId
          try
            if password protected of targetNote then error "SP2O_NOTE_LOCKED"
          end try
          if body of targetNote does not contain markerText then error "SP2O_IDENTITY_MISMATCH"
          set body of targetNote to htmlText
        end if
        return id of targetNote
      end tell
    end run
  APPLESCRIPT
  saved_note_id = private_tempfile(['sp2o-note', '.html'], message.fetch('html').to_s.encode('UTF-8')) do |html_path|
    run_notes_script(
      script, message.fetch('accountId'), message.fetch('folderId'), note_id, title, html_path, existing_marker
    ).strip
  end

  saved_media = 0
  failed_media = 0
  Array(message['attachments']).each do |attachment|
    begin
      bytes = Base64.strict_decode64(attachment.fetch('data'))
      attachment_script = <<~APPLESCRIPT
        on run argv
          set accountId to item 1 of argv
          set noteId to item 2 of argv
          set attachmentName to item 3 of argv
          set attachmentPath to item 4 of argv
          tell application "Notes"
            set targetAccount to first account whose id is accountId
            set targetNote to first note of targetAccount whose id is noteId
            repeat with oldAttachment in attachments of targetNote
              if name of oldAttachment is attachmentName then delete oldAttachment
            end repeat
            make new attachment at targetNote with data (POSIX file attachmentPath as alias)
          end tell
        end run
      APPLESCRIPT
      private_named_tempfile(attachment.fetch('name'), bytes) do |path|
        run_notes_script(attachment_script, message.fetch('accountId'), saved_note_id, attachment.fetch('name'), path)
      end
      saved_media += 1
    rescue StandardError
      failed_media += 1
    end
  end
  {
    'ok' => true,
    'noteId' => saved_note_id,
    'title' => title,
    'externalKey' => external_key,
    'savedMedia' => saved_media,
    'failedMedia' => failed_media
  }
rescue StandardError => error
  raise HostActionError.new('Apple 備忘錄已鎖定', 'NOTES_LOCKED') if error.message.include?('SP2O_NOTE_LOCKED')
  raise HostActionError.new('Apple 備忘錄身分不符', 'NOTES_IDENTITY_MISMATCH') if error.message.include?('SP2O_IDENTITY_MISMATCH')
  raise HostActionError.new('Apple 備忘錄資料夾不存在', 'NOTES_LOCATION_MISSING') if error.message.match?(/Can.t get|Invalid index/i)

  raise
end

def notes_simple_action(action, account_id, note_id, external_key)
  _, marker = notes_read_verified(account_id, note_id, external_key)
  command = action == 'delete' ? 'delete targetNote' : 'show targetNote'
  script = <<~APPLESCRIPT
    on run argv
      set accountId to item 1 of argv
      set noteId to item 2 of argv
      set markerText to item 3 of argv
      tell application "Notes"
        set targetAccount to first account whose id is accountId
        set targetNote to first note of targetAccount whose id is noteId
        if body of targetNote does not contain markerText then error "SP2O_IDENTITY_MISMATCH"
        #{command}
        activate
      end tell
    end run
  APPLESCRIPT
  run_notes_script(script, account_id, note_id, marker)
  { 'ok' => true }
rescue StandardError => error
  raise HostActionError.new('Apple 備忘錄身分不符', 'NOTES_IDENTITY_MISMATCH') if error.message.include?('SP2O_IDENTITY_MISMATCH')
  raise HostActionError.new('找不到 Apple 備忘錄', 'NOTES_NOT_FOUND') if error.message.match?(/Can.t get|Invalid index/i)

  raise
end

def open_storage_file(root, relative_path)
  target = resolve_target(root, relative_path)
  raise 'Storage file not found' if target.nil? || !File.file?(target)

  command = if File.directory?(File.join(root, '.obsidian'))
              vault = URI.encode_www_form_component(File.basename(root))
              file = URI.encode_www_form_component(relative_path)
              ['obsidian://open?vault=' + vault + '&file=' + file]
            else
              [target]
            end
  _output, error, status = Open3.capture3('/usr/bin/open', *command)
  error = subprocess_utf8(error, 'Unable to decode the open command error', scrub: true)
  raise(error.strip.empty? ? 'Unable to open storage file' : error.strip) unless status.success?

  { 'ok' => true }
end

def markdown_source_url(path)
  return '' if File.symlink?(path) || !File.file?(path)

  File.open(path, 'r:bom|utf-8') do |file|
    return '' unless file.gets&.strip == '---'

    80.times do
      line = file.gets
      break if line.nil? || line.strip == '---'

      match = line.match(/\Asource_url:\s*(.*?)\s*\z/)
      next unless match

      value = match[1]
      if value.start_with?('"')
        parsed = JSON.parse(value)
        return parsed.is_a?(String) ? parsed : ''
      end
      return value.sub(/\s+#.*\z/, '').strip
    end
  end
  ''
rescue EncodingError, JSON::ParserError, SystemCallError
  ''
end

def markdown_entries(directory, recursive, relative = '', depth = 0)
  return [] unless directory && File.directory?(directory)
  return [] if depth > 8

  entries = []
  Dir.each_child(directory) do |raw_name|
    # macOS can expose byte strings for non-UTF-8 filenames; joining them into UTF-8 paths
    # raises 'incompatible character encodings'. Skip only names we cannot safely represent.
    name = raw_name.to_s.dup.force_encoding(Encoding::UTF_8)
    next unless name.valid_encoding?

    path = File.join(directory, name)
    next if File.symlink?(path)

    relative_path = relative.empty? ? name : File.join(relative, name)
    if File.file?(path) && name.end_with?('.md')
      entries << { 'name' => relative_path, 'sourceUrl' => markdown_source_url(path) }
    elsif recursive && File.directory?(path)
      entries.concat(markdown_entries(path, true, relative_path, depth + 1))
    end
  end
  entries
end

POST_TYPE_FOLDERS = {
  'post' => '發文',
  'reply' => '回覆',
  'quote' => '引用',
  'thread' => '串文'
}.freeze
ARCHIVE_FOLDER = 'Archive'

def markdown_frontmatter(path)
  content = File.read(path, mode: 'r:bom|utf-8')
  match = content.match(/\A---\r?\n(.*?)\r?\n---(?:\r?\n|\z)/m)
  return [content, {}] unless match

  data = YAML.safe_load(
    match[1],
    permitted_classes: [Date, DateTime, Time],
    permitted_symbols: [],
    aliases: false
  )
  [content, data.is_a?(Hash) ? data : {}]
rescue EncodingError, Psych::Exception, SystemCallError
  ['', {}]
end

def status_author(url)
  match = url.to_s.match(%r{(?:x|twitter)\.com/([^/?#]+)/status/\d+}i)
  match ? match[1].downcase : ''
end

def archived_post_type(frontmatter)
  return nil unless %w[x threads].include?(frontmatter['source'].to_s)
  return nil if frontmatter['status'] == 'draft'

  post_type = frontmatter['post_type'].to_s
  return post_type if POST_TYPE_FOLDERS.key?(post_type)

  source_author = status_author(frontmatter['source_url'])
  reply_author = status_author(frontmatter['reply_to'])
  return 'thread' if frontmatter['thread_count'].to_i > 1
  return 'thread' if !source_author.empty? && source_author == reply_author
  return 'quote' if frontmatter['quoted_url'] || frontmatter['quoted_from']
  return 'reply' if frontmatter['reply_to']

  'post'
end

def frontmatter_time(frontmatter, filename)
  value = frontmatter['created']
  return value.to_time if value.respond_to?(:to_time)
  return Time.parse(value.to_s) unless value.nil? || value.to_s.empty?

  match = filename.match(/\A(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2}))?_/)
  return nil unless match

  Time.local(
    *match[1].split('-').map(&:to_i),
    match[2] ? match[2].to_i : 0,
    match[3] ? match[3].to_i : 0
  )
rescue ArgumentError
  nil
end

def legacy_file_time(path)
  stat = File.stat(path)
  times = [stat.mtime]
  begin
    times << stat.birthtime
  rescue NotImplementedError
    # Linux CI/filesystems may not expose birthtime; mtime still covers migrated notes.
  end
  times.min
rescue SystemCallError
  nil
end

def rewrite_moved_markdown_links(content, source_directory, target_directory)
  content.gsub(/(!\[[^\]]*\]\(<)([^>]+)(>\))/) do
    prefix = Regexp.last_match(1)
    link = Regexp.last_match(2)
    suffix = Regexp.last_match(3)
    next prefix + link + suffix if link.match?(%r{\A(?:https?:|data:)}i)

    absolute = Pathname(source_directory).join(link).cleanpath
    relative = absolute.relative_path_from(Pathname(target_directory)).to_s
    prefix + relative + suffix
  end
end

def archive_social_posts(vault, relative_path, older_than)
  directory = resolve_directory(vault, relative_path)
  return { 'ok' => true, 'moved' => [], 'skipped' => [] } unless directory && File.directory?(directory)

  cutoff = Time.iso8601(older_than.to_s)
  moved = []
  skipped = []
  source_directories = [[directory, relative_path, nil]]

  # v1.5.0 曾把舊筆記放在根目錄下的分類資料夾；升級後一併搬進 Archive。
  POST_TYPE_FOLDERS.each do |post_type, folder|
    legacy_relative = File.join(relative_path, folder)
    legacy_directory = resolve_directory(vault, legacy_relative)
    if legacy_directory && File.directory?(legacy_directory)
      source_directories << [legacy_directory, legacy_relative, post_type]
    end
  end

  source_directories.each do |source_directory, source_relative, legacy_post_type|
    Dir.each_child(source_directory).sort.each do |name|
      source = File.join(source_directory, name)
      next if File.symlink?(source) || !File.file?(source) || !name.end_with?('.md')

      content, frontmatter = markdown_frontmatter(source)
      next if frontmatter['status'] == 'draft'

      # 沒有 frontmatter 的舊手動筆記沿用所在分類，日期退回檔案最早時間。
      post_type = archived_post_type(frontmatter) || legacy_post_type
      created_at = frontmatter_time(frontmatter, name)
      created_at ||= legacy_file_time(source) if legacy_post_type
      next unless post_type && created_at && created_at < cutoff

      folder = POST_TYPE_FOLDERS.fetch(post_type)
      source_path = File.join(source_relative, name)
      target_path = File.join(relative_path, ARCHIVE_FOLDER, folder, name)
      target = resolve_target(vault, target_path, create_directories: true)
      if File.exist?(target)
        skipped << { 'path' => source_path, 'reason' => 'target_exists' }
        next
      end

      updated = rewrite_moved_markdown_links(content, File.dirname(source), File.dirname(target))
      stat = File.stat(source)
      begin
        File.rename(source, target)
        if updated != content
          atomic_write(target, updated.encode('UTF-8'))
          File.chmod(stat.mode, target)
          File.utime(stat.atime, stat.mtime, target)
        end
        moved << { 'from' => source_path, 'to' => target_path }
      rescue StandardError
        File.rename(target, source) if File.exist?(target) && !File.exist?(source)
        raise
      end
    end
  end

  # 舊分類資料夾全部搬空後移除；若仍有七天內筆記或其他檔案就保留。
  source_directories.drop(1).each do |legacy_directory, _legacy_relative, _legacy_post_type|
    Dir.rmdir(legacy_directory) if Dir.empty?(legacy_directory)
  rescue SystemCallError
    # 資料已正確封存；空資料夾清理屬 best-effort，不應讓整批被誤報失敗。
  end

  { 'ok' => true, 'moved' => moved, 'skipped' => skipped }
end

def handle_message(message)
  case message['action']
  when 'ping'
    host_status
  when 'chooseFolder', 'chooseVault'
    folder = choose_folder
    config = load_config.merge('folderPath' => folder)
    config.delete('vaultPath')
    save_config(config)
    {
      'ok' => true,
      'configured' => true,
      'version' => HOST_VERSION,
      'folderName' => File.basename(folder),
      'vaultName' => File.basename(folder),
      'isObsidianVault' => File.directory?(File.join(folder, '.obsidian'))
    }
  when 'configure'
    folder = validate_folder(message['folderPath'] || message['vaultPath'])
    config = load_config.merge('folderPath' => folder)
    config.delete('vaultPath')
    save_config(config)
    {
      'ok' => true,
      'configured' => true,
      'version' => HOST_VERSION,
      'folderName' => File.basename(folder),
      'vaultName' => File.basename(folder),
      'isObsidianVault' => File.directory?(File.join(folder, '.obsidian'))
    }
  when 'notesLocations'
    notes_locations
  when 'notesExistsLocation'
    location = notes_locations['locations'].any? do |item|
      item['accountId'] == message['accountId'] && item['folderId'] == message['folderId']
    end
    { 'ok' => true, 'configured' => location, 'exists' => location }
  when 'notesFind'
    notes_find(message.fetch('accountId'), message.fetch('folderId'), message.fetch('externalKey'))
  when 'notesRead'
    notes_read(message.fetch('accountId'), message.fetch('noteId'), message.fetch('externalKey'))
  when 'notesListPosts'
    notes_list_posts(
      message.fetch('accountId'), message.fetch('folderId'), message['cursor'], message['limit']
    )
  when 'notesAttachmentHashes'
    notes_attachment_hashes(message)
  when 'notesMergeDuplicates'
    notes_merge_duplicates(message)
  when 'notesUpsert'
    notes_upsert(message)
  when 'notesAttach'
    notes_attach(message)
  when 'notesExists'
    begin
      notes_read(message.fetch('accountId'), message.fetch('noteId'), message.fetch('externalKey'))
      { 'ok' => true, 'exists' => true }
    rescue HostActionError => error
      raise unless %w[NOTES_NOT_FOUND NOTES_IDENTITY_MISMATCH].include?(error.code)

      { 'ok' => true, 'exists' => false }
    end
  when 'notesDelete'
    notes_simple_action(
      'delete', message.fetch('accountId'), message.fetch('noteId'), message.fetch('externalKey')
    )
  when 'notesShow'
    notes_simple_action(
      'show', message.fetch('accountId'), message.fetch('noteId'), message.fetch('externalKey')
    )
  when 'write'
    vault = configured_vault
    target = resolve_target(vault, message['path'], create_directories: true)
    bytes = if message['encoding'] == 'base64'
              Base64.strict_decode64(message.fetch('data'))
            else
              message.fetch('data').to_s.encode('UTF-8')
            end
    atomic_write(target, bytes)
    # 補存的筆記寫入時間是「現在」，但它代表的是幾天前的貼文。不校正的話，
    # 依修改時間排序的檢視會把整批補存的舊貼文擠在最前面。
    mtime = message['mtime']
    if mtime.is_a?(Numeric) && mtime.positive?
      begin
        time = Time.at(mtime)
        File.utime(time, time, target)
      rescue SystemCallError => e
        # 排序是附加價值，設不了時間不該讓存檔失敗
        warn "utime failed: #{e.message}"
      end
    end
    { 'ok' => true }
  when 'read'
    vault = configured_vault
    target = resolve_target(vault, message['path'])
    raise 'Storage file not found' if target.nil? || !File.file?(target)

    { 'ok' => true, 'data' => File.binread(target).force_encoding('UTF-8') }
  when 'readBinary'
    vault = configured_vault
    target = resolve_target(vault, message['path'])
    raise 'Storage file not found' if target.nil? || !File.file?(target)

    { 'ok' => true, 'data' => Base64.strict_encode64(File.binread(target)) }
  when 'remove'
    vault = configured_vault
    target = resolve_target(vault, message['path'])
    remove_file(target) if target && File.file?(target)
    { 'ok' => true }
  when 'open'
    open_storage_file(configured_vault, message.fetch('path'))
  when 'exists'
    vault = configured_vault
    target = resolve_target(vault, message['path'])
    { 'ok' => true, 'exists' => !target.nil? && File.file?(target) }
  when 'list'
    vault = configured_vault
    directory = resolve_directory(vault, message.fetch('path'))
    entries = markdown_entries(directory, message['recursive'] == true)
    names = entries.map { |entry| entry['name'] }
    { 'ok' => true, 'names' => names, 'entries' => entries }
  when 'archiveSocialPosts'
    vault = configured_vault
    archive_social_posts(vault, message.fetch('path'), message.fetch('olderThan'))
  when 'cleanEmptyMediaFolders'
    vault = configured_vault
    media_root = resolve_directory(vault, message.fetch('path'))
    removed = 0
    if media_root && File.directory?(media_root)
      Dir.each_child(media_root) do |name|
        # 摘要可能是空字串（檔名以底線結尾），所以底線後不要求任何字元
        next unless name.match?(/^\d{4}-\d{2}-\d{2}_\d{4}_/)

        directory = File.join(media_root, name)
        next if File.symlink?(directory) || !File.directory?(directory) || !Dir.empty?(directory)

        Dir.rmdir(directory)
        removed += 1
      rescue Errno::ENOENT, Errno::ENOTEMPTY
        next
      end
    end
    { 'ok' => true, 'removed' => removed }
  else
    raise 'Unknown native host action'
  end
end

loop do
  # read_message 也要保護：framing 錯誤時回覆 framed 錯誤再結束，
  # 而不是讓程序直接崩潰、Chrome 只看到 "Native host has exited"
  begin
    message = read_message
  rescue StandardError => error
    begin
      write_message('ok' => false, 'error' => error.message, 'version' => HOST_VERSION)
    rescue StandardError
      # stdout 也壞掉時已無法回報，直接結束
    end
    break
  end
  break if message.nil?

  begin
    response = handle_message(message)
    write_message(response)
  rescue StandardError => error
    response = { 'ok' => false, 'error' => error.message, 'version' => HOST_VERSION }
    response['code'] = error.code if error.respond_to?(:code)
    write_message(response)
  end
end
