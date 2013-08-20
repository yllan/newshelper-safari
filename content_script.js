/****************************************************************
 * Message Handler
 *
 * 呼叫 global.html 裡面的 js。例如 Safari 不支援 injected script 做
 * cross-origin AJAX，但是在 global page 裡可以，所以要 ajax 就要透過
 * message global 來達成。
 ****************************************************************/

var newshelper_message_handler_table = {};

var newshelper_send_message_to_global_page = function(name, data, handler) {
  newshelper_message_handler_table[name + "Receive"] = (handler ? handler : function() {});
  safari.self.tab.dispatchMessage(name, data);
};

var newshelper_receive_message_handler = function(messageEvent) {
  var handler = newshelper_message_handler_table[messageEvent.name];
  if (handler) handler(messageEvent.message);
};

safari.self.addEventListener("message", newshelper_receive_message_handler, false);



/****************************************************************
 * Database
 *
 * Safari 不支援 indexedDB，所以這邊使用 WebSQL。
 ****************************************************************/

var get_newshelper_db = function(callback) {
  // Already opened
  if (null != opened_db) {
    callback(opened_db);
    return;
  }

  try {
    if (!window.openDatabase) {
      console.log('WebSQL not supported');
    } else {
      var shortName = 'newshelper_db';
      var version = '1.0';
      var displayName = '新聞小幫手 Database';
      var maxSize = 50 * 1024 * 1024; // in bytes
      var db = openDatabase(shortName, version, displayName, maxSize);
      
      opened_db = db;
      db.transaction(function(tranx) {
        tranx.executeSql('CREATE TABLE IF NOT EXISTS report(id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,  news_title TEXT NOT NULL, news_link TEXT UNIQUE NOT NULL, report_title TEXT, report_link TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);', []);
        tranx.executeSql('CREATE TABLE IF NOT EXISTS read_news(id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, title TEXT, link TEXT UNIQUE NOT NULL, last_seen_at INTEGER);', []);
      });
      callback(db);
    }
  } catch(e) {
    if (e == 2) {
      console.log("新聞小幫手: Invalid database version."); // Version number mismatch, migrate!
      // TODO: Migrate schema
    } else {
      console.log("新聞小幫手: Unknown error " + e + ".");
    }
  }
};

var open_newshelper_db = function(callback) {
  get_newshelper_db(function(db) {
    db.transaction(callback);
  });
}

var opened_db = null;

var get_time_diff = function(time){
  var delta = Math.floor((new Date()).getTime() / 1000) - time;
  if (delta < 60) {
    return delta + " 秒前";
  } else if (delta < 60 * 60) {
    return Math.floor(delta / 60) + " 分鐘前";
  } else if (delta < 60 * 60 * 24) {
    return Math.floor(delta / 60 / 60) + " 小時前";
  } else {
    return Math.floor(delta / 60 / 60 / 24) + " 天前";
  }
};


var check_recent_seen = function(report) {
  open_newshelper_db(function(tranx) {
    if (parseInt(report.deleted_at, 10)) return;

    var handler = function(t, results) {
      if (results.rows.length != 1) return;
      var result = results.rows.item(0);

      var title = '新聞小幫手提醒您';
      var body = '您於' + get_time_diff(result.last_seen_at) + ' 看的新聞「' + result.title + '」 被人回報有錯誤：' + report.report_title;
      var link = report.report_link;

      var notify = function() {
        var fallbackNotification = function() {
          // TODO
        };

        var displayNotification = function() {
          console.log(link);
          var n = new Notification(title, {
            body: body,
            tag: report.news_link
          });
          n.onclick = function() {
            window.focus();
            window.location = link;
            window.open(link);
            // this.cancel();
          }
          n.show();
        };

        if (!window.Notification) { // Notification not supported or denied. Use popover instead.
          fallbackNotification();
        } else if (Notification.permission === 'default') { 
          Notification.requestPermission(function() { notify(); });
        } else if (Notification.permission === 'granted') {
          displayNotification();
        } else { // denied
          fallbackNotification();
        }  
      };
      notify();
    }
      
    tranx.executeSql("SELECT * FROM read_news n WHERE link = ? LIMIT 1;", [report.news_link], handler, null);
  });
};

// 有的話，傳一筆最新的 report 給 callback。
// 沒有，則傳 null 給 callback。
var get_latest_report = function(callback) {
  open_newshelper_db(function(tranx) {
    var dataHandler = function(transaction, results) {
      if (results.rows.length == 1) {
        callback(results.rows.item(0));
      } else {
        callback(null);
      }
    };
    
    var errorHandler = function(transaction, error) {
      callback(null);
      return false; // not-fatal error
    }

    tranx.executeSql("SELECT * FROM report ORDER BY updated_at DESC LIMIT 1;", 
                      [/* values for ? placeholder in SQL */], 
                      dataHandler, 
                      errorHandler);
  });
};


// 跟遠端 API server 同步回報資料
var sync_report_data = function() {
  get_latest_report(function(latestReport) {
    var url = 'http://newshelper.g0v.tw/index/data?time=' + (latestReport ? parseInt(latestReport.updated_at) : 0);
    newshelper_send_message_to_global_page('fetchReportsAfter', latestReport, function(ret) {
      if (ret.data) {
        // 把 report 加入 Database
        open_newshelper_db(function(tranx) {
          for (var i = 0; i < ret.data.length; i++) {
            var report = ret.data[i];
            tranx.executeSql("INSERT OR REPLACE INTO report (news_title, news_link, report_title, report_link, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?);", 
                              [report["news_title"], report["news_link"], report["report_title"], report["report_link"], report["created_at"], report["updated_at"], report["deleted_at"]]);
          }
        });

        // 比對是否有之前看過的新聞被 report
        for (var i = 0; i < ret.data.length; i++)
          check_recent_seen(ret.data[i]);
      }
    });

    setTimeout(sync_report_data, 15 * 60 * 1000); // 每 15 分鐘檢查一次是否有更新
  });
};


var log_browsed_link = function(link, title) {
  if (!link) return;

  open_newshelper_db(function(tranx) {
    tranx.executeSql("INSERT OR REPLACE INTO read_news (title, link, last_seen_at) VALUES (?, ?, ?);", 
                      [title, link, Math.floor((new Date()).getTime() / 1000)]);
  });
};


// 從 db 中判斷 title, url 是否是錯誤新聞，是的話執行 cb 並傳入資訊
var check_report = function(title, url, callback){
  if (!url) return;

  open_newshelper_db(function(tranx) {
    tranx.executeSql("SELECT * FROM report WHERE news_link = ? LIMIT 1;", [url], function(tranx, results) {
      if (results.rows.length == 1 && !parseInt(results.rows.item(0).deleted_at, 10)) {
        callback(results.rows.item(0));
      }
    });
  });
};


var buildWarningMessage = function(options){
  return '<div class="newshelper-warning-facebook">' +
    '<div class="arrow-up"></div>' +
    '注意！您可能是<b>問題新聞</b>的受害者' +
    '<span class="newshelper-description">' +
    $('<span></span>').append($('<a></a>').attr({href: options.link, target: '_blank'}).text(options.title)).html() +
    '</span>' +
    '</div>';
};


var censorFacebook = function(baseNode) {
  if (window.location.host.indexOf("www.facebook.com") !== -1) {
    /* log browsing history into local database for further warning */
    /* add warning message to a Facebook post if necessary */
    var censorFacebookNode = function(containerNode, titleText, linkHref) {
      var matches = ('' + linkHref).match('^http://www\.facebook\.com/l\.php\\?u=([^&]*)');
      if (matches) {
        linkHref = decodeURIComponent(matches[1]);
      }
      var containerNode = $(containerNode);
      var className = "newshelper-checked";
      if (containerNode.hasClass(className))
        return;
      else
        containerNode.addClass(className);

      /* log the link first */
      log_browsed_link(linkHref, titleText);

      check_report(titleText, linkHref, function(report) {
        containerNode.addClass(className);
        containerNode.append(buildWarningMessage({
          title: report.report_title,
          link: report.report_link
        }));
      });
    };


    /* my timeline */
    $(baseNode).find(".uiStreamAttachments").each(function(idx, uiStreamAttachment) {
      var uiStreamAttachment = $(uiStreamAttachment)
      if (!uiStreamAttachment.hasClass("newshelper-checked")) {
        var titleText = uiStreamAttachment.find(".uiAttachmentTitle").text();
        var linkHref = uiStreamAttachment.find("a").attr("href");
        censorFacebookNode(uiStreamAttachment, titleText, linkHref);
      }
    });

    /* others' timeline, fan page */
    $(baseNode).find(".shareUnit").each(function(idx, shareUnit) {
      var shareUnit = $(shareUnit);
      if (!shareUnit.hasClass("newshelper-checked")) {
        var titleText = shareUnit.find(".fwb").text();
        var linkHref = shareUnit.find("a").attr("href");
        censorFacebookNode(shareUnit, titleText, linkHref)
      };
    });

    /* post page (single post) */
    $(baseNode).find("._6kv").each(function(idx, userContent) {
      var userContent = $(userContent);
      if (!userContent.hasClass("newshelper-checked")) {
        var titleText = userContent.find(".mbs").text();
        var linkHref = userContent.find("a").attr("href");
        censorFacebookNode(userContent, titleText, linkHref);
      };
    });
  }
};


var registerObserver = function() {
  var MutationObserver = window.MutationObserver || window.WebKitMutationObserver;
  var mutationObserverConfig = {
    target: document.getElementsByTagName("body")[0],
    config: {
      attributes: true,
      childList: true,
      characterData: true
    }
  };
  var mutationObserver = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
      censorFacebook(mutation.target);
    });
  });
  mutationObserver.observe(mutationObserverConfig.target, mutationObserverConfig.config);
};


var main = function() {
  $(function(){
    // fire up right after the page loaded
    // 可能會呼叫多次，是因為 iframe 的關係?
    censorFacebook(document.body);

    sync_report_data();

    /* deal with changed DOMs (i.e. AJAX-loaded content) */
    registerObserver();
  });
};

main();
