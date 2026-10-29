(ns capture
  "Records the nREPL exchanges shown on the landing page.

  Starts a real nREPL server, talks to it over a plain socket, and writes every
  message that went back and forth to ../data/exchanges.json, both as EDN for
  reading and as the bencode that went over the wire. The local home directory
  is replaced with ~ wherever it shows up (file paths in lookup results).

  Run it from this directory: clojure -M -m capture"
  (:require
   [clojure.java.io :as io]
   [clojure.string :as str]
   [nrepl.bencode :as bencode]
   [nrepl.server :as server]
   [nrepl.version :as version])
  (:import
   (java.io ByteArrayOutputStream PushbackInputStream)
   (java.net Socket)
   (java.nio.charset StandardCharsets)))

(def ^:private home (System/getProperty "user.home"))

(defn- ->clj
  "Turns a decoded bencode value, whose strings are byte arrays, into plain
  Clojure data, with the home directory hidden."
  [x]
  (cond
    (bytes? x) (->clj (String. ^bytes x StandardCharsets/UTF_8))
    (string? x) (str/replace x home "~")
    (map? x) (into {} (map (fn [[k v]] [(->clj k) (->clj v)])) x)
    (sequential? x) (mapv ->clj x)
    :else x))

;;; Talking to the server

(defn- connect [port]
  (let [socket (Socket. "localhost" (int port))]
    {:socket socket
     :in (PushbackInputStream. (.getInputStream socket))
     :out (.getOutputStream socket)
     :log (atom [])}))

(defn- send! [{:keys [out log]} msg]
  (bencode/write-bencode out msg)
  (.flush ^java.io.OutputStream out)
  (swap! log conj {:from "client" :msg msg}))

(defn- receive! [{:keys [in log]}]
  (let [msg (->clj (bencode/read-nrepl-message in))]
    (swap! log conj {:from "server" :msg msg})
    msg))

(defn- has-status? [msg id status]
  (and (= id (get msg "id")) (some #{status} (get msg "status"))))

(defn- await-done
  "Reads responses until every request in `ids` has reported done."
  [conn & ids]
  (loop [pending (set ids)]
    (when (seq pending)
      (let [{:strs [id] :as msg} (receive! conn)]
        (recur (cond-> pending (has-status? msg id "done") (disj id)))))))

(defn- await-status [conn id status]
  (loop []
    (when-not (has-status? (receive! conn) id status)
      (recur))))

(defn- request!
  "Sends `msg` and returns its responses once it's done."
  [conn msg]
  (send! conn msg)
  (let [from (count @(:log conn))]
    (await-done conn (get msg "id"))
    (->> (subvec @(:log conn) from) (map :msg) (filter #(= (get msg "id") (get % "id"))))))

(defn- with-connection
  "Calls `f` with a connection of its own to the server on `port`."
  [port f]
  (let [conn (connect port)]
    (try
      (f conn)
      (finally
        (.close ^Socket (:socket conn))))))

;;; Rendering
;;
;; Both views are lists of [class text] tokens, which the page wraps in spans:
;; k(eyword), s(tring), n(umber or length prefix), p(unctuation), t(ext of a
;; bencode string), or "" for plain text. In the EDN view the id and session
;; also get an r, and the page dims them: they're there to route the message,
;; and the session's UUID is mostly noise to a reader.

(def ^:private lead
  "The keys a message reads best starting with: a request's op and its
  arguments, a response's payload."
  ["op" "code" "prefix" "sym" "stdin" "interrupt-id" "new-session"
   "out" "err" "value" "ns"])

(def ^:private tail
  "The keys that go last: the status, and the keys that route the message."
  ["status" "id" "session"])

(def ^:private routing #{"id" "session"})

(defn- sort-keys
  "A top-level message's keys in reading order: `lead`, everything else
  alphabetically, then `tail`. Nested maps are sorted alphabetically."
  [m top?]
  (if top?
    (sort-by (fn [k]
               (let [l (.indexOf ^java.util.List lead k)
                     t (.indexOf ^java.util.List tail k)]
                 (cond
                   (>= l 0) [0 l ""]
                   (>= t 0) [2 t ""]
                   :else [1 0 k])))
             (keys m))
    (sort (keys m))))

(defn- dimmed [tokens]
  (map (fn [[class text]] [(if (= "" class) class (str class " r")) text]) tokens))

(defn- joined [sep parts]
  (apply concat (interpose sep parts)))

(defn- flat
  "`x` as EDN on one line."
  [x top?]
  (cond
    (map? x) (concat [["p" "{"]]
                     (joined [["" " "]] (for [k (sort-keys x top?)]
                                          (cond->> (concat [["k" (str ":" k)] ["" " "]] (flat (get x k) false))
                                            (and top? (routing k)) dimmed)))
                     [["p" "}"]])
    (sequential? x) (concat [["p" "["]] (joined [["" " "]] (map #(flat % false) x)) [["p" "]"]])
    (string? x) [["s" (pr-str x)]]
    (number? x) [["n" (str x)]]
    :else [["" (pr-str x)]]))

(defn- len [tokens]
  (transduce (map (comp count second)) + tokens))

(def ^:private width
  "Columns the EDN view tries to stay within, roughly what fits the page's
  second window."
  54)

(defn- lay
  "`x` as EDN starting at column `col`, as lines of tokens. Only the lines
  after the first carry their indentation, since the caller places the first."
  [x col top?]
  (let [one (vec (flat x top?))]
    (if (or (not (coll? x)) (<= (+ col (len one)) width))
      [one]
      (let [[open close items] (if (map? x)
                                 ["{" "}" (for [k (sort-keys x top?)] [k (get x k)])]
                                 ["[" "]" (for [v x] [nil v])])
            inner (inc col)
            indent ["" (apply str (repeat inner \space))]
            entry (fn [[k v]]
                    (let [lines (if k
                                  (let [kt [["k" (str ":" k)] ["" " "]]
                                        [line & more] (lay v (+ inner (len kt)) false)]
                                    (cons (into kt line) more))
                                  (lay v inner false))]
                      (cond->> lines
                        (and top? (routing k)) (map (comp vec dimmed)))))
            lines (vec (apply concat
                              (map-indexed (fn [i [line & more]]
                                             (cons (into (if (zero? i) [["p" open]] [indent]) line)
                                                   more))
                                           (map entry items))))]
        (update lines (dec (count lines)) conj ["p" close])))))

(defn- bencode-tokens [x]
  (cond
    (map? x) (concat [["p" "d"]]
                     (mapcat (fn [k] (concat (bencode-tokens k) (bencode-tokens (get x k))))
                             (sort (keys x)))
                     [["p" "e"]])
    (sequential? x) (concat [["p" "l"]] (mapcat bencode-tokens x) [["p" "e"]])
    (integer? x) [["p" "i"] ["n" (str x)] ["p" "e"]]
    :else (let [s (str x)]
            [["n" (str (count (.getBytes s StandardCharsets/UTF_8)) ":")] ["t" s]])))

(defn- wire [msg]
  (let [out (ByteArrayOutputStream.)]
    (bencode/write-bencode out msg)
    (String. (.toByteArray out) StandardCharsets/UTF_8)))

(defn- render [{:keys [from msg]}]
  (let [tokens (vec (bencode-tokens msg))]
    ;; The tokens are only worth showing if they spell out what nREPL writes.
    (assert (= (wire msg) (apply str (map second tokens)))
            (str "bencode view doesn't match the wire for " (pr-str msg)))
    {"from" from
     "edn" (lay msg 0 true)
     "bencode" tokens}))

(defn- record
  "Calls `f` with a connection of its own and returns the messages exchanged
  over it, rendered. Anything the server sends after `f` returns stays unread,
  as it would for a client that stops reading once its requests are done."
  [port f]
  (with-connection port (fn [conn]
                          (f conn)
                          (mapv render @(:log conn)))))

;;; The exchanges

(defn- new-session [conn id]
  (some #(get % "new-session") (request! conn {"op" "clone" "id" id})))

(defn- quiet-session
  "A new session, cloned over `conn` before the exchange starts, so the clone
  doesn't show up in it. It has to be the exchange's own connection: a session
  asks for stdin over the connection that cloned it."
  [conn]
  (let [session (new-session conn "0")]
    (reset! (:log conn) [])
    session))

(defn- exchanges [port]
  (let [ex #(record port %)]
    (sorted-map
     "eval"
     (ex #(request! % {"op" "eval" "code" "(+ 1 2)" "id" "1"}))

     "output"
     (ex #(request! % {"op" "eval" "id" "1"
                       "code" "(println \"Hello from the server\")\n(* 6 7)"}))

     "sessions"
     (ex (fn [conn]
           (let [s (new-session conn "1")]
             (request! conn {"op" "eval" "code" "(set! *print-length* 3)" "session" s "id" "2"})
             (request! conn {"op" "eval" "code" "(range 10)" "session" s "id" "3"}))))

     "interrupt"
     ;; nREPL 1.8.0 sends the interrupted eval's err and eval-error after its
     ;; done, which leaves them unread.
     (ex (fn [conn]
           (let [session (quiet-session conn)]
             (send! conn {"op" "eval" "code" "(Thread/sleep 60000)" "session" session "id" "1"})
             (Thread/sleep 500)
             (send! conn {"op" "interrupt" "interrupt-id" "1" "session" session "id" "2"})
             (await-done conn "1" "2"))))

     "stdin"
     (ex (fn [conn]
           (let [session (quiet-session conn)]
             (send! conn {"op" "eval" "code" "(str \"Hello, \" (read-line))"
                          "session" session "id" "1"})
             (await-status conn "1" "need-input")
             (send! conn {"op" "stdin" "stdin" "nREPL\n" "session" session "id" "2"})
             (await-done conn "1" "2"))))

     "tooling"
     (ex #(do (request! % {"op" "completions" "prefix" "with-o" "ns" "user" "id" "1"})
              (request! % {"op" "lookup" "sym" "with-out-str" "ns" "user" "id" "2"})))

     "describe"
     (ex #(request! % {"op" "describe" "id" "1"})))))

(defn- free-port []
  (with-open [socket (java.net.ServerSocket. 0)]
    (.getLocalPort socket)))

(defn- run-until-ready
  "Starts the nREPL server `cmd`, in `dir` if given, and calls `f` with the
  line where it says it's listening, while it's still running. Anything it
  prints before that (downloads, JVM warnings) is skipped."
  [cmd dir f]
  (let [proc (-> (ProcessBuilder. ^java.util.List cmd)
                 (cond-> dir (.directory dir))
                 (.redirectErrorStream true)
                 (.start))
        lines (line-seq (io/reader (.getInputStream proc)))]
    (try
      (f (or (first (filter #(str/includes? % "nREPL server") lines))
             (throw (ex-info "The server exited without starting" {:cmd cmd}))))
      (finally
        (.destroy proc)))))

(defn- babashka
  "The same kind of request, sent to Babashka's nREPL server."
  []
  (let [port (free-port)]
    (run-until-ready ["bb" "nrepl-server" (str port)] nil
                     (fn [_]
                       (record port #(request! % {"op" "eval" "id" "1"
                                                  "code" "[(+ 1 2) (System/getProperty \"babashka.version\")]"}))))))

(defn- startup
  "Starts a server the way the page tells people to, and keeps what it prints."
  [nrepl-version]
  (let [dir (doto (io/file (System/getProperty "java.io.tmpdir")
                           (str "nrepl-capture-" (System/nanoTime)))
              (.mkdirs))
        deps (format "{:deps {nrepl/nrepl {:mvn/version \"%s\"}}}" nrepl-version)
        port-file (io/file dir ".nrepl-port")]
    (try
      (run-until-ready ["clojure" "-Sdeps" deps "-M" "-m" "nrepl.cmdline"] dir
                       (fn [line]
                         ;; nrepl.cmdline prints the message before it writes
                         ;; the port file.
                         (loop [tries 50]
                           (when (and (not (.exists port-file)) (pos? tries))
                             (Thread/sleep 100)
                             (recur (dec tries))))
                         {"output" line
                          "port" (slurp port-file)}))
      (finally
        (run! io/delete-file (reverse (file-seq dir)))))))

;;; Writing it out

(defn- json [x]
  (cond
    (string? x) (str \" (str/escape x (fn [c]
                                         (case c
                                           \\ "\\\\"
                                           \" "\\\""
                                           \newline "\\n"
                                           \tab "\\t"
                                           (when (< (int c) 0x20)
                                             (format "\\u%04x" (int c))))))
                     \")
    (number? x) (str x)
    (map? x) (str "{" (str/join "," (for [[k v] x] (str (json k) ":" (json v)))) "}")
    (sequential? x) (str "[" (str/join "," (map json x)) "]")
    (nil? x) "null"
    :else (str x)))

(defn- pretty-json
  "JSON with one message per line, so re-recording makes a readable diff."
  [x depth indent]
  (if (or (>= depth 3) (not (coll? x)) (empty? x))
    (json x)
    (let [pad (apply str (repeat (+ indent 2) \space))
          item #(pretty-json % (inc depth) (+ indent 2))
          [open close items] (if (map? x)
                               ["{" "}" (for [[k v] x] (str pad (json k) ": " (item v)))]
                               ["[" "]" (for [v x] (str pad (item v)))])]
      (str open "\n" (str/join ",\n" items) "\n" (apply str (repeat indent \space)) close))))

(defn -main [& _]
  (let [nrepl-version (:version-string version/version)
        server (server/start-server :port 0)
        data (sorted-map "version" nrepl-version
                         "exchanges" (assoc (exchanges (:port server)) "babashka" (babashka))
                         "startup" (startup nrepl-version))
        out (io/file ".." "data" "exchanges.json")]
    (server/stop-server server)
    (io/make-parents out)
    (spit out (str (pretty-json data 0 0) "\n"))
    (println "Wrote" (.getPath out))
    (shutdown-agents)))
