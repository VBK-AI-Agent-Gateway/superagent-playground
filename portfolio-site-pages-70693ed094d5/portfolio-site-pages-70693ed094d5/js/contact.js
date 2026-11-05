/* contact.js —— 联系表单前端校验（原生 JS + HTML5 约束，零依赖）
   校验规则：姓名必填（≥2 字）、邮箱必填且格式正确、留言必填（≥10 字）。
   全部通过后仅做「静态占位提交」：不发送任何网络请求，不接后端。   */
(function () {
  "use strict";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function messageFor(field) {
    var value = field.value.trim();
    var name = field.getAttribute("name");

    if (field.validity.valueMissing || value === "") {
      if (name === "name") { return "请填写您的姓名。"; }
      if (name === "email") { return "请填写您的邮箱地址。"; }
      return "请填写留言内容。";
    }

    if (name === "email" && !EMAIL_RE.test(value)) {
      return "邮箱格式不正确，请检查后重试（例如 name@example.com）。";
    }
    if (name === "name" && value.length < 2) {
      return "姓名至少需要 2 个字符。";
    }
    if (name === "message" && value.length < 10) {
      return "留言至少需要 10 个字符，便于我了解您的需求。";
    }
    if (field.validity.tooLong) {
      return "内容超出长度限制，请适当精简。";
    }
    return "";
  }

  function setFieldError(field, message) {
    var wrapper = field.closest(".field");
    var box = wrapper ? wrapper.querySelector(".field__error") : null;
    field.setAttribute("aria-invalid", message ? "true" : "false");
    if (message) {
      field.setCustomValidity(message);
      if (wrapper) { wrapper.classList.add("has-error"); }
      if (box) { box.textContent = message; }
    } else {
      field.setCustomValidity("");
      if (wrapper) { wrapper.classList.remove("has-error"); }
      if (box) { box.textContent = ""; }
    }
    return !message;
  }

  function validateField(field) {
    return setFieldError(field, messageFor(field));
  }

  function init() {
    var form = document.getElementById("contact-form");
    if (!form) {
      return;
    }

    var status = document.getElementById("form-status");
    var fields = [].slice.call(form.querySelectorAll("input[name], textarea[name]"));

    fields.forEach(function (field) {
      field.addEventListener("blur", function () { validateField(field); });
      field.addEventListener("input", function () {
        // 出错后即时纠正；无错时不打扰。
        if (field.closest(".field") && field.closest(".field").classList.contains("has-error")) {
          validateField(field);
        }
      });
    });

    form.addEventListener("submit", function (event) {
      // 阻止真实提交（静态占位，无后端）；同时拦截不合法输入。
      event.preventDefault();

      var firstInvalid = null;
      fields.forEach(function (field) {
        var ok = validateField(field);
        if (!ok && !firstInvalid) { firstInvalid = field; }
      });

      if (firstInvalid) {
        if (status) {
          status.hidden = false;
          status.className = "form-status form-status--error";
          status.textContent = "提交未成功：请修正上方标红的字段后重试。";
          status.focus();
        }
        firstInvalid.focus();
        return;
      }

      var name = form.elements.name.value.trim();
      // 先清空字段与错误态，再写成功提示：reset 会触发下面的 reset 监听器隐藏提示，
      // 顺序颠倒会把刚写好的成功消息一并清掉。
      form.reset();
      fields.forEach(function (field) { setFieldError(field, ""); });
      if (status) {
        status.hidden = false;
        status.className = "form-status form-status--ok";
        status.textContent = "提交成功（静态占位）：已收到，" + name +
          "。本站为纯静态演示，不会真实发送邮件，也没有后端存储。";
        status.focus();
      }
    });

    form.addEventListener("reset", function () {
      fields.forEach(function (field) { setFieldError(field, ""); });
      if (status) {
        status.hidden = true;
        status.textContent = "";
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
